import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import algosdk from 'algosdk'
import type { RetiGhostSDK } from 'reti-ghost-sdk'
import { isOptedInToAsset } from '@/api/algod'
import {
  algorandClient,
  getSimulateStakingPoolClient,
  getSimulateValidatorClient,
  getStakingPoolClient,
  getStakingPoolFactory,
  getValidatorClient,
  getXGovRegistryClient,
} from '@/api/clients'
import { fetchNfd } from '@/api/nfd'
import { sdkAt, untilReadNodeCaughtUp } from '@/api/reti'
import { ALGORAND_ZERO_ADDRESS_STRING } from '@/constants/accounts'
import { GatingType } from '@/constants/gating'
import { StakedInfo, ValidatorPoolKey } from '@/contracts/StakingPoolClient'
import {
  Constraints,
  MbrAmounts,
  NodePoolAssignmentConfig,
  PoolInfo,
  ValidatorConfig,
  ValidatorCurState,
  ValidatorRegistryClient,
} from '@/contracts/ValidatorRegistryClient'
import { StakerPoolData, StakerValidatorData } from '@/interfaces/staking'
import {
  EntryGatingAssets,
  FindPoolForStakerResponse,
  LocalPoolInfo,
  PoolData,
  PoolGlobalState,
  PoolGlobalStates,
  Validator,
  ValidatorCoreData,
  ValidatorConfigInput,
} from '@/interfaces/validator'
import { BalanceChecker } from '@/utils/balanceChecker'
import { epochAdjustedApy, ghostValidatorToParts } from '@/utils/contracts'
import { TransactionHandlerProps } from './transactionState'
import { wrapTransactionSigner } from '@/hooks/useTransactionState'
import { sleep } from '@/utils/time'
import { untilAborted } from '@/utils/abort'
import { fetchNodelyVotingPerf } from '@/api/nodely'

export async function fetchNumValidators(round?: bigint): Promise<number> {
  return sdkAt(round).getNumValidators()
}

/**
 * Fetches config, state, pools and node/pool assignments for EVERY validator, as of `round` (the
 * latest state when undefined).
 *
 * One request: the registry's count and every validator in one batched read of the ghost reader,
 * consistent at a single round.
 */
export async function fetchAllValidatorData(
  round?: bigint,
  signal?: AbortSignal,
): Promise<ValidatorCoreData[]> {
  const validators = await sdkAt(round).getAllValidators({ signal })

  // Ids run from 1 to the count, in order
  return validators
    .map((validator, i) => {
      try {
        return ghostValidatorToParts(i + 1, validator)
      } catch (error) {
        // Drop the one validator rather than failing the whole dashboard
        console.warn(`Skipping validator ${i + 1}, could not be read:`, error)
        return null
      }
    })
    .filter((validator): validator is ValidatorCoreData => validator !== null)
}

/**
 * Fetches a single validator's core data, as of `round`.
 */
/** Core reads in flight, by validator and round, so the queries split from one read share it. */
const coreReads = new Map<string, Promise<ValidatorCoreData>>()

/**
 * A validator's config, state, pools and node assignments, from one read. Concurrent calls for
 * the same validator and round (the four per-part queries loading together) share the request.
 */
export function fetchValidatorCoreData(
  validatorId: number | bigint,
  round?: bigint,
): Promise<ValidatorCoreData> {
  const key = `${validatorId}@${round ?? 'latest'}`
  let read = coreReads.get(key)
  if (!read) {
    read = readValidatorCoreData(validatorId, round).finally(() => coreReads.delete(key))
    coreReads.set(key, read)
  }
  return read
}

async function readValidatorCoreData(
  validatorId: number | bigint,
  round?: bigint,
): Promise<ValidatorCoreData> {
  const id = Number(validatorId)
  const [validator] = await sdkAt(round).getValidators([id])
  // A validator that doesn't exist (or didn't yet, at a past round) reads as zeros
  if (!validator || validator.config.id !== BigInt(id)) {
    throw new ValidatorNotFoundError(`Validator with id "${id}" not found!`)
  }
  return ghostValidatorToParts(id, validator)
}

export async function fetchValidatorConfig(
  validatorId: number | bigint,
  round?: bigint,
): Promise<ValidatorConfig> {
  return (await fetchValidatorCoreData(validatorId, round)).config
}

export async function fetchValidatorState(
  validatorId: number | bigint,
  round?: bigint,
): Promise<ValidatorCurState> {
  return (await fetchValidatorCoreData(validatorId, round)).state
}

export async function fetchValidatorPools(
  validatorId: number | bigint,
  round?: bigint,
): Promise<LocalPoolInfo[]> {
  return (await fetchValidatorCoreData(validatorId, round)).pools
}

export async function fetchValidatorNodePoolAssignments(
  validatorId: number | bigint,
  round?: bigint,
): Promise<NodePoolAssignmentConfig> {
  return (await fetchValidatorCoreData(validatorId, round)).nodePoolAssignment
}

/** A pool's on-chain APY in percent, from its moving average (hundredths of a percent). */
export function ewmaToApy(ewma: bigint): number {
  return (Number(ewma) / 10000) * 100
}

/**
 * Every listed pool's global state and balance, as of `round`, in one batched read.
 */
export async function fetchPoolGlobalStates(
  poolAppIds: bigint[],
  round?: bigint,
  signal?: AbortSignal,
): Promise<PoolGlobalStates> {
  if (poolAppIds.length === 0) {
    return {}
  }
  const states = await sdkAt(round).getPoolStates(poolAppIds, { signal })
  return Object.fromEntries(
    states
      .filter((state) => state.exists)
      .map((state): [string, PoolGlobalState] => [
        String(state.poolAppId),
        {
          lastPayout: state.lastPayout,
          algodVer: state.algodVer || undefined,
          apy: ewmaToApy(state.ewma),
          balance: state.balance,
          minBalance: state.minBalance,
          roundsPerDay: state.roundsPerDay || undefined,
        },
      ]),
  )
}

/**
 * Creates a base validator object from the validator data
 */
export function createBaseValidator({
  id,
  config,
  state,
  pools,
  nodePoolAssignment,
}: {
  id: number
  config: Omit<ValidatorConfig, 'id'>
  state: ValidatorCurState
  pools: LocalPoolInfo[]
  nodePoolAssignment: NodePoolAssignmentConfig
}): Validator {
  return {
    id,
    config,
    state,
    pools,
    nodePoolAssignment,
  }
}

/**
 * A pool's inputs to its validator's metrics, from on-chain state alone: its spendable balance,
 * last payout and moving-average APY, corrected for its validator's epoch length. Nodely's
 * realtime APY is layered on later, by {@link fetchNodelyPoolApy}, once the rest of the page has
 * loaded.
 *
 * @param globalState - the pool's entry from {@link fetchPoolGlobalStates}, read at the same
 *   round as the validator.
 * @param epochRoundLength - the validator's epoch, to correct the moving average for; left as
 *   is without it.
 */
export function processPoolData(
  pool: LocalPoolInfo,
  globalState: PoolGlobalState | undefined,
  epochRoundLength?: bigint | number,
): PoolData {
  const balance = globalState ? globalState.balance - globalState.minBalance : 0n
  const apy =
    globalState && epochRoundLength
      ? epochAdjustedApy(globalState.apy, epochRoundLength, globalState.roundsPerDay)
      : globalState?.apy
  return {
    poolAppId: pool.poolAppId,
    balance,
    lastPayout: globalState?.lastPayout,
    apy,
    roundsPerDay: globalState?.roundsPerDay,
  }
}

/**
 * Nodely's realtime APY for a pool, which also counts external deposits. Nodely only answers
 * "now". Failures read as zero (see `fetchNodelyVotingPerf`).
 */
export async function fetchNodelyPoolApy(
  poolAppId: bigint,
): Promise<{ apy: number; extDeposits: number }> {
  const address = algosdk.getApplicationAddress(poolAppId).toString()
  const data = await fetchNodelyVotingPerf(address)
  return { apy: data.apy, extDeposits: data.total_external_deposits }
}

/**
 * Fetches all validator data and enrichment data in parallel. Used after adding a new validator
 * to seed the query cache with complete data.
 */
export async function fetchValidator(validatorId: number): Promise<Validator> {
  const { config, state, pools, nodePoolAssignment } = await fetchValidatorCoreData(validatorId)

  // Create base validator
  const validator = createBaseValidator({
    id: validatorId,
    config,
    state,
    pools,
    nodePoolAssignment,
  })

  // Fetch all enrichment data in parallel
  const enrichmentPromises: Promise<void>[] = []

  if (validator.config.rewardTokenId > 0) {
    enrichmentPromises.push(
      fetchAssetAt(validator.config.rewardTokenId).then((token) => {
        validator.rewardToken = token
      }),
    )
  }

  if (validator.config.entryGatingType === GatingType.AssetId) {
    enrichmentPromises.push(
      Promise.all(
        validator.config.entryGatingAssets.map(async (assetId) => {
          if (assetId > 0) {
            return fetchAssetAt(assetId)
          }
          return null
        }),
      ).then((assets) => {
        validator.gatingAssets = assets.filter(Boolean) as algosdk.modelsv2.Asset[]
      }),
    )
  }

  if (validator.config.nfdForInfo > 0) {
    enrichmentPromises.push(
      fetchNfd(validator.config.nfdForInfo, { view: 'full' }).then((nfd) => {
        validator.nfd = nfd
      }),
    )
  }

  // Wait for all enrichment data
  if (enrichmentPromises.length > 0) {
    await Promise.all(enrichmentPromises)
  }

  return validator
}

export class ValidatorNotFoundError extends Error {}

export async function addValidator(
  values: ValidatorConfigInput,
  nfdAppId: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  const { addValidatorMbr } = (
    await validatorClient.send.getMbrAmounts({
      args: {},
    })
  ).return!

  const payValidatorMbr = await validatorClient.appClient.createTransaction.fundAppAccount({
    sender: activeAddress,
    amount: AlgoAmount.MicroAlgo(addValidatorMbr),
    extraFee: AlgoAmount.Algos(10),
  })

  // Check balance
  const requiredBalance = (payValidatorMbr.payment?.amount ?? 0n) + payValidatorMbr.fee + 1000n
  await BalanceChecker.check(activeAddress, requiredBalance, 'Add validator')

  const entryGatingType = Number(values.entryGatingType || 0)
  const entryGatingAddress = values.entryGatingAddress || ALGORAND_ZERO_ADDRESS_STRING
  const entryGatingAssets = new Array(4).fill(0n) as EntryGatingAssets

  for (let i = 0; i < values.entryGatingAssets.length && i < 4; i++) {
    entryGatingAssets[i] = BigInt(values.entryGatingAssets[i] ?? 0n)
  }

  const validatorConfig: ValidatorConfig = {
    id: 0n, // id not known yet
    owner: values.owner,
    manager: values.manager,
    nfdForInfo: nfdAppId,
    entryGatingType,
    entryGatingAddress,
    entryGatingAssets,
    gatingAssetMinBalance: BigInt(values.gatingAssetMinBalance || 0),
    rewardTokenId: BigInt(values.rewardTokenId) ?? 0n,
    rewardPerPayout: BigInt(values.rewardPerPayout) ?? 0n,
    epochRoundLength: Number(values.epochRoundLength),
    percentToValidator: Math.round(Number(values.percentToValidator) * 10000),
    validatorCommissionAddress: values.validatorCommissionAddress,
    minEntryStake: AlgoAmount.Algos(Number(values.minEntryStake)).microAlgos,
    maxAlgoPerPool: AlgoAmount.Algos(Number(values.maxAlgoPerPool || 0) * 1_000_000).microAlgos,
    poolsPerNode: Number(values.poolsPerNode),
    sunsettingOn: 0n,
    sunsettingTo: 0n,
  }

  const result = await validatorClient
    .newGroup()
    .addValidator({
      args: {
        mbrPayment: payValidatorMbr,
        nfdName: values.nfdForInfo || '',
        config: validatorConfig,
      },
    })
    .send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()

  return Number(result.returns![0])
}

export function callGetMbrAmounts(validatorClient: ValidatorRegistryClient) {
  return validatorClient.send.getMbrAmounts({ args: {} })
}

/** MBR + constraints reads in flight, by round: both come from one SDK call. */
const mbrAndConstraintsReads = new Map<
  string,
  ReturnType<RetiGhostSDK['getMbrAmountsAndProtocolConstraints']>
>()

/**
 * The registry's MBR amounts and protocol constraints as of `round`, from one read. The two
 * queries split from it (loaded together on every page) share the request.
 */
function fetchMbrAndConstraints(round?: bigint) {
  const key = String(round ?? 'latest')
  let read = mbrAndConstraintsReads.get(key)
  if (!read) {
    read = sdkAt(round)
      .getMbrAmountsAndProtocolConstraints()
      .finally(() => mbrAndConstraintsReads.delete(key))
    mbrAndConstraintsReads.set(key, read)
  }
  return read
}

/** The registry's MBR amounts as of `round`. `signal` stops the wait, not the shared read. */
export async function fetchMbrAmounts(round?: bigint, signal?: AbortSignal): Promise<MbrAmounts> {
  return (await untilAborted(fetchMbrAndConstraints(round), signal)).mbrAmounts
}

export async function addStakingPool(
  validatorId: bigint,
  nodeNum: number,
  poolMbr: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<ValidatorPoolKey> {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  const payValidatorAddPoolMbr = await validatorClient.appClient.createTransaction.fundAppAccount({
    sender: activeAddress,
    amount: AlgoAmount.MicroAlgo(poolMbr),
  })

  // Check balance
  const requiredBalance =
    (payValidatorAddPoolMbr.payment?.amount ?? 0n) +
    payValidatorAddPoolMbr.fee +
    1000n +
    1000n +
    2000n

  await BalanceChecker.check(activeAddress, requiredBalance, 'Add staking pool')

  const addPoolResponse = await validatorClient
    .newGroup()
    .gas({ args: {}, note: '1' })
    .gas({ args: {}, note: '2' })
    .addPool({
      args: { mbrPayment: payValidatorAddPoolMbr, validatorId, nodeNum },
      extraFee: AlgoAmount.MicroAlgos(1000),
      sender: activeAddress,
      validityWindow: 100,
    })
    .send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()

  return addPoolResponse.returns![2]!
}

export async function initStakingPoolStorage(
  poolAppId: bigint,
  poolInitMbr: bigint,
  optInRewardToken: boolean,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<void> {
  const suggestedParams = await algorandClient.getSuggestedParams()
  const mbrAmount = optInRewardToken ? poolInitMbr + AlgoAmount.Algos(0.1).microAlgos : poolInitMbr

  const payPoolInitStorageMbr = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: activeAddress,
    receiver: algosdk.getApplicationAddress(poolAppId),
    amount: mbrAmount,
    suggestedParams,
  })

  // Check balance
  const requiredBalance =
    (payPoolInitStorageMbr.payment?.amount ?? 0n) +
    payPoolInitStorageMbr.fee +
    1000n +
    1000n +
    3000n

  await BalanceChecker.check(activeAddress, requiredBalance, 'Pool storage requirement payment')

  const stakingPoolClient = await getStakingPoolClient(poolAppId, signer, activeAddress)

  await stakingPoolClient
    .newGroup()
    .gas({ args: {}, note: '1' })
    .gas({ args: {}, note: '2' })
    .initStorage({
      args: {
        // the required MBR payment transaction
        mbrPayment: payPoolInitStorageMbr,
      },
      extraFee: AlgoAmount.MicroAlgos(2000),
    })
    .send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()
}

export async function doesStakerNeedToPayMbr(
  activeAddress: string,
  authAddr?: string,
  client?: ValidatorRegistryClient,
): Promise<boolean> {
  const validatorClient = client || (await getSimulateValidatorClient(activeAddress))

  const result = await validatorClient.send.doesStakerNeedToPayMbr({
    args: { staker: activeAddress },
  })

  if (result.returns?.[0] === undefined) {
    throw new Error('Error checking if staker needs to pay MBR')
  }
  return result.return!
}

export async function findPoolForStaker(
  validatorId: number,
  amountToStake: bigint,
  activeAddress: string,
  authAddr?: string,
  client?: ValidatorRegistryClient,
): Promise<FindPoolForStakerResponse> {
  const validatorClient = client || (await getSimulateValidatorClient(activeAddress))

  const result = await validatorClient
    .newGroup()
    .gas({
      args: {},
    })
    .findPoolForStaker({
      args: {
        validatorId,
        staker: activeAddress,
        amountToStake,
      },
      extraFee: AlgoAmount.MicroAlgos(1000),
    })
    .simulate({ skipSignatures: true, allowUnnamedResources: true })

  const errorMessage = result.simulateResponse.txnGroups[0].failureMessage

  if (errorMessage || !result.returns[1]) {
    throw new Error(`Error finding pool for staker: ${errorMessage || 'No pool found'}`)
  }
  const [[valId, poolId, poolAppId], isNewStakerToValidator, isNewStakerToProtocol] =
    result.returns[1]

  const poolKey: ValidatorPoolKey = {
    id: valId,
    poolId: poolId,
    poolAppId: poolAppId,
  }

  return { poolKey, isNewStakerToValidator, isNewStakerToProtocol }
}

export async function addStake(
  validatorId: number,
  stakeAmount: bigint, // microalgos
  valueToVerify: bigint,
  rewardTokenId: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<ValidatorPoolKey> {
  const validatorClient = await getValidatorClient(signer, activeAddress)
  const suggestedParams = await algorandClient.getSuggestedParams()

  const stakeTransferPayment = await validatorClient.appClient.createTransaction.fundAppAccount({
    sender: activeAddress,
    amount: AlgoAmount.MicroAlgo(stakeAmount),
  })

  const needsOptInTxn = rewardTokenId > 0 && !(await isOptedInToAsset(activeAddress, rewardTokenId))

  const simulateValidatorClient = await getSimulateValidatorClient(activeAddress)

  const simulateComposer = simulateValidatorClient
    .newGroup()
    .gas({ args: [], note: '1' })
    .gas({ args: [], note: '2' })
    .addStake({
      args: {
        stakedAmountPayment: stakeTransferPayment,
        validatorId,
        valueToVerify,
      },
      staticFee: AlgoAmount.MicroAlgos(240_000),
      validityWindow: 200,
    })

  if (needsOptInTxn) {
    const rewardTokenOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: activeAddress,
      amount: 0,
      assetIndex: Number(rewardTokenId),
      suggestedParams,
    })

    simulateComposer.addTransaction(rewardTokenOptInTxn)
  }

  const simulateResults = await simulateComposer.simulate({
    skipSignatures: true,
    allowUnnamedResources: true,
  })

  stakeTransferPayment.group = undefined

  const feeAmount = AlgoAmount.MicroAlgos(
    1000 *
      Math.floor(
        ((simulateResults.simulateResponse.txnGroups[0].appBudgetAdded as number) + 699) / 700,
      ) -
      1000, // subtract back out the opcodes added from the gas call(s) which were paid as part of their normal fees,
  )

  let requiredBalance =
    (stakeTransferPayment.payment?.amount ?? 0n) + stakeTransferPayment.fee + feeAmount.microAlgos

  const composer = validatorClient
    .newGroup()
    .gas({ args: [], note: '1' })
    .gas({ args: [], note: '2' })
    .addStake({
      args: {
        // --
        // This is the actual send of stake to the validator contract (which then sends to the staking pool)
        stakedAmountPayment: { txn: stakeTransferPayment, signer },
        // --
        validatorId,
        valueToVerify,
      },
      extraFee: feeAmount,
    })

  if (needsOptInTxn) {
    const rewardTokenOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: activeAddress,
      amount: 0,
      assetIndex: Number(rewardTokenId),
      suggestedParams,
    })

    requiredBalance += rewardTokenOptInTxn.fee

    composer.addTransaction(rewardTokenOptInTxn)
  }

  // Check balance
  await BalanceChecker.check(activeAddress, requiredBalance, 'Add stake')

  const result = await composer.send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()

  return result.returns![2]!
}

export async function callFindPoolForStaker(
  validatorId: number | bigint,
  staker: string,
  amountToStake: bigint,
  validatorClient: ValidatorRegistryClient,
) {
  return validatorClient.send.findPoolForStaker({ args: { validatorId, staker, amountToStake } })
}

/**
 * A staker's positions, grouped by validator, as of `round`: one batched read for every pool
 * the staker is in, plus one for those pools' `lastPayout`.
 */
export async function fetchStakerValidatorData(
  staker: string,
  round?: bigint,
  signal?: AbortSignal,
): Promise<StakerValidatorData[]> {
  const sdk = sdkAt(round)
  const positions = await sdk.getStakerPositions([staker], { signal })
  signal?.throwIfAborted()

  // Filter out potential duplicates (temporary UI fix for duplicate staked pools bug)
  const seen = new Set<bigint>()
  const uniquePositions = positions.filter(({ poolAppId }) => {
    if (seen.has(poolAppId)) return false
    seen.add(poolAppId)
    return true
  })

  const poolStates = await fetchPoolGlobalStates(
    uniquePositions.map(({ poolAppId }) => poolAppId),
    round,
    signal,
  )

  const allPools: StakerPoolData[] = uniquePositions.map(
    ({ validatorId, poolId, poolAppId, info }) => ({
      ...info,
      poolKey: { id: validatorId, poolId, poolAppId },
      lastPayout: poolStates[String(poolAppId)]?.lastPayout ?? 0n,
    }),
  )

  // Group pool stakes by validatorId and sum up balances
  return allPools.reduce((acc, pool) => {
    const { id: validatorId } = pool.poolKey

    // Check if we already have an entry for this validator
    const existingData = acc.find((data) => data.validatorId === validatorId)

    if (existingData) {
      // staker is in another pool for this validator, update validator totals
      existingData.balance += pool.balance
      existingData.totalRewarded += pool.totalRewarded
      existingData.rewardTokenBalance += pool.rewardTokenBalance
      existingData.entryRound =
        pool.entryRound > existingData.entryRound ? pool.entryRound : existingData.entryRound
      existingData.lastPayout =
        existingData.lastPayout > pool.lastPayout ? existingData.lastPayout : pool.lastPayout
      existingData.pools.push(pool) // add pool to existing StakerPoolData[]
    } else {
      // First pool for this validator, add new entry
      acc.push({
        validatorId,
        balance: pool.balance,
        totalRewarded: pool.totalRewarded,
        rewardTokenBalance: pool.rewardTokenBalance,
        entryRound: pool.entryRound,
        lastPayout: pool.lastPayout,
        pools: [pool], // add pool to new StakerPoolData[]
      })
    }

    return acc
  }, [] as StakerValidatorData[])
}

/** The registry's protocol constraints as of `round`. Some follow online stake, so they vary. */
export async function fetchProtocolConstraints(
  round?: bigint,
  signal?: AbortSignal,
): Promise<Constraints> {
  return (await untilAborted(fetchMbrAndConstraints(round), signal)).constraints
}

export async function removeStake(
  poolAppId: bigint,
  amountToUnstake: bigint,
  rewardTokenId: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const suggestedParams = await algorandClient.getSuggestedParams()

  const stakingPoolSimulateClient = await getSimulateStakingPoolClient(poolAppId, activeAddress)

  const needsOptInTxn = rewardTokenId > 0 && !(await isOptedInToAsset(activeAddress, rewardTokenId))

  const simulateComposer = stakingPoolSimulateClient
    .newGroup()
    .gas({ args: [], note: '1', staticFee: AlgoAmount.MicroAlgos(0) })
    .gas({ args: [], note: '2', staticFee: AlgoAmount.MicroAlgos(0) })
    .removeStake({
      args: { staker: activeAddress, amountToUnstake },
      staticFee: AlgoAmount.MicroAlgos(240000),
    })

  if (needsOptInTxn) {
    const rewardTokenOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: activeAddress,
      amount: 0,
      assetIndex: Number(rewardTokenId),
      suggestedParams,
    })

    simulateComposer.addTransaction(rewardTokenOptInTxn)
  }

  const simulateResult = await simulateComposer.simulate({
    skipSignatures: true,
    allowUnnamedResources: true,
  })

  const feeAmount = AlgoAmount.MicroAlgos(
    1000 *
      Math.floor(
        ((simulateResult.simulateResponse.txnGroups[0].appBudgetAdded as number) + 699) / 700,
      ) -
      2000, // subtract back out the opcodes added from the two gas calls which were paid as part of their normal fees,
  )

  let requiredBalance = feeAmount.microAlgos

  const stakingPoolClient = await getStakingPoolClient(poolAppId, signer, activeAddress)

  const composer = stakingPoolClient
    .newGroup()
    .gas({ args: [], note: '1' })
    .gas({ args: [], note: '2' })
    .removeStake({
      args: { staker: activeAddress, amountToUnstake },
      extraFee: feeAmount,
    })

  if (needsOptInTxn) {
    const rewardTokenOptInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: activeAddress,
      amount: 0,
      assetIndex: Number(rewardTokenId),
      suggestedParams,
    })

    requiredBalance += rewardTokenOptInTxn.fee

    composer.addTransaction(rewardTokenOptInTxn)
  }

  // Check balance
  await BalanceChecker.check(activeAddress, requiredBalance, 'Remove stake')

  await composer.send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()
}

export async function epochBalanceUpdate(
  poolAppId: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<void> {
  try {
    const stakingPoolSimulateClient = await getSimulateStakingPoolClient(poolAppId, activeAddress)

    const simulateResult = await stakingPoolSimulateClient
      .newGroup()
      .gas({
        args: [],
        note: '1',
        staticFee: AlgoAmount.MicroAlgos(0),
      })
      .gas({
        args: [],
        note: '2',
        staticFee: AlgoAmount.MicroAlgos(0),
      })
      .epochBalanceUpdate({
        args: {},
        staticFee: AlgoAmount.MicroAlgos(240_000),
      })
      .simulate({ skipSignatures: true, allowUnnamedResources: true })

    const feeAmount = AlgoAmount.MicroAlgos(
      1000 *
        Math.floor(
          ((simulateResult.simulateResponse.txnGroups[0].appBudgetAdded as number) + 699) / 700,
        ) -
        2000, // subtract back out the opcodes added from the gas call(s) which were paid as part of their normal fees,
    )

    // Check balance
    const requiredBalance = feeAmount.microAlgos
    await BalanceChecker.check(activeAddress, requiredBalance, 'Epoch balance update')

    const stakingPoolClient = await getStakingPoolClient(poolAppId, signer, activeAddress)

    await stakingPoolClient
      .newGroup()
      .gas({ args: [], note: '1' })
      .gas({ args: [], note: '2' })
      .epochBalanceUpdate({ args: {}, extraFee: feeAmount })
      .send({ populateAppCallResources: true })
    await untilReadNodeCaughtUp()
  } catch (error) {
    console.error(error)
    throw error
  }
}

export async function claimTokens(
  pools: PoolInfo[],
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const [algorand, stakingFactory] = getStakingPoolFactory()

  const feeComposer = algorand.newGroup()

  for (const pool of pools) {
    const client = stakingFactory.getAppClientById({
      appId: pool.poolAppId,
      defaultSender: activeAddress,
    })
    feeComposer
      .addAppCallMethodCall(
        await client.params.gas({ args: [], note: '1', staticFee: (0).microAlgo() }),
      )
      .addAppCallMethodCall(
        await client.params.gas({ args: [], note: '2', staticFee: (0).microAlgo() }),
      )
      .addAppCallMethodCall(
        await client.params.claimTokens({ args: {}, staticFee: (240_000).microAlgo() }),
      )
  }

  const simulateResult = await feeComposer.simulate({
    skipSignatures: true,
    allowUnnamedResources: true,
  })

  const feeAmount = AlgoAmount.MicroAlgos(
    1000 *
      Math.floor(
        ((simulateResult.simulateResponse.txnGroups[0].appBudgetAdded as number) + 699) / 700,
      ) -
      2000, // subtract back out the opcodes added from the gas call(s) which were paid as part of their normal fees,
  )

  const composer = algorand.newGroup()

  for (const pool of pools) {
    const client = stakingFactory.getAppClientById({
      appId: pool.poolAppId,
      // Assumes this address was registered already with the AlgorandClient and the use-wallet signer
      defaultSender: activeAddress,
      defaultSigner: signer,
    })
    composer
      .addAppCallMethodCall(await client.params.gas({ args: [], note: '1' }))
      .addAppCallMethodCall(await client.params.gas({ args: [], note: '2' }))
      .addAppCallMethodCall(await client.params.claimTokens({ args: {}, extraFee: feeAmount }))
  }

  await composer.send({ populateAppCallResources: true })
  await untilReadNodeCaughtUp()
}

/** A pool's stakers as of `round`, from its `stakers` box (one REST read), empty slots left out. */
export async function fetchStakedInfoForPool(
  poolAppId: bigint,
  round?: bigint,
  signal?: AbortSignal,
): Promise<StakedInfo[]> {
  const stakers = await sdkAt(round).getPoolStakers(poolAppId, { signal })
  return stakers.map(({ account, balance, totalRewarded, rewardTokenBalance, entryRound }) => ({
    account,
    balance,
    totalRewarded,
    rewardTokenBalance,
    entryRound,
  }))
}

/**
 * An asset's params as of `round`, in algod's model so it drops in where `fetchAsset` results
 * are used. A deleted (or not yet created) asset has no params.
 */
export async function fetchAssetAt(
  assetId: number | bigint,
  round?: bigint,
  signal?: AbortSignal,
): Promise<algosdk.modelsv2.Asset> {
  const [asset] = await sdkAt(round).getAssets([assetId], { signal })
  if (!asset || 'deleted' in asset) {
    throw new Error(`Asset ${assetId} not found`)
  }
  const { creator, total, decimals, unitName, name } = asset.params
  return new algosdk.modelsv2.Asset({
    index: asset.index,
    params: new algosdk.modelsv2.AssetParams({ creator, total, decimals, unitName, name }),
  })
}

export async function changeValidatorManager(
  validatorId: number | bigint,
  manager: string,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  // Check balance
  await BalanceChecker.check(activeAddress, 1000n, 'Change validator manager')

  const result = await validatorClient.send.changeValidatorManager({
    args: { validatorId, manager },
    populateAppCallResources: true,
  })
  await untilReadNodeCaughtUp()
  return result
}

export async function changeValidatorSunsetInfo(
  validatorId: number | bigint,
  sunsettingOn: number,
  sunsettingTo: number,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  // Check balance
  await BalanceChecker.check(activeAddress, 1000n, 'Change validator sunset info')

  const result = await validatorClient.send.changeValidatorSunsetInfo({
    args: { validatorId, sunsettingOn, sunsettingTo },
    populateAppCallResources: true,
  })
  await untilReadNodeCaughtUp()
  return result
}

export async function changeValidatorNfd(
  validatorId: number | bigint,
  nfdAppId: bigint,
  nfdName: string,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  // Check balance
  await BalanceChecker.check(activeAddress, 1000n, 'Change validator NFD')

  const result = await validatorClient.send.changeValidatorNfd({
    args: { validatorId, nfdAppId, nfdName },
    extraFee: AlgoAmount.MicroAlgos(1000),
    populateAppCallResources: true,
  })
  await untilReadNodeCaughtUp()
  return result
}

export async function changeValidatorCommissionAddress(
  validatorId: number | bigint,
  commissionAddress: string,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  // Check balance
  await BalanceChecker.check(activeAddress, 1000n, 'Change validator commission address')

  const result = await validatorClient.send.changeValidatorCommissionAddress({
    args: { validatorId, commissionAddress },
    populateAppCallResources: true,
  })
  await untilReadNodeCaughtUp()
  return result
}

export async function changeValidatorRewardInfo(
  validatorId: number | bigint,
  entryGatingType: number,
  entryGatingAddress: string,
  entryGatingAssets: EntryGatingAssets,
  gatingAssetMinBalance: bigint,
  rewardPerPayout: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  const validatorClient = await getValidatorClient(signer, activeAddress)

  // Check balance
  await BalanceChecker.check(activeAddress, 1000n, 'Change validator reward info')

  const result = await validatorClient.send.changeValidatorRewardInfo({
    args: {
      validatorId,
      entryGatingType,
      entryGatingAddress,
      entryGatingAssets,
      gatingAssetMinBalance,
      rewardPerPayout,
    },
    populateAppCallResources: true,
  })
  await untilReadNodeCaughtUp()
  return result
}

export async function linkPoolToNfd(
  poolAppId: bigint,
  nfdName: string,
  nfdAppId: number,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
) {
  try {
    const nfdAppAddress = algosdk.getApplicationAddress(nfdAppId)
    const poolAppAddress = algosdk.getApplicationAddress(poolAppId)

    const boxStorageMbrAmount = AlgoAmount.MicroAlgos(20500)
    const feeAmount = AlgoAmount.MicroAlgos(5000)

    const payBoxStorageMbrTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: activeAddress,
      receiver: nfdAppAddress,
      amount: boxStorageMbrAmount.microAlgos,
      suggestedParams: await algorandClient.getSuggestedParams(),
    })

    const updateNfdAppCall = algosdk.makeApplicationNoOpTxnFromObject({
      appIndex: nfdAppId,
      sender: activeAddress,
      suggestedParams: await algorandClient.getSuggestedParams(),
      appArgs: [
        new TextEncoder().encode('update_field'),
        new TextEncoder().encode('u.cav.algo.a'),
        poolAppAddress.publicKey,
      ],
    })

    // Check balance
    const requiredBalance =
      (payBoxStorageMbrTxn.payment?.amount ?? 0n) +
      payBoxStorageMbrTxn.fee +
      updateNfdAppCall.fee +
      feeAmount.microAlgos

    await BalanceChecker.check(activeAddress, requiredBalance, 'Link pool to NFD')

    const stakingPoolClient = await getStakingPoolClient(poolAppId, signer, activeAddress)

    await stakingPoolClient
      .newGroup()
      .addTransaction(payBoxStorageMbrTxn)
      .addTransaction(updateNfdAppCall)
      .linkToNfd({ args: { nfdAppId, nfdName }, extraFee: feeAmount })
      .send({ populateAppCallResources: true })
    await untilReadNodeCaughtUp()
  } catch (error) {
    console.error(error)
    throw error
  }
}

export interface RequestSubscribeXGovProps extends TransactionHandlerProps {
  xgovFee?: bigint
  pools: string[]
}

export async function requestSubscribeXGov({
  activeAddress,
  innerSigner,
  setStatus,
  refetch,
  xgovFee,
  pools,
}: RequestSubscribeXGovProps) {
  if (!innerSigner) return

  const signer = wrapTransactionSigner(innerSigner, setStatus)

  if (!activeAddress || !signer) {
    setStatus(new Error('No active address or transaction signer'))
    return
  }

  if (!xgovFee) {
    setStatus(new Error('xgovFee is not set'))
    return
  }

  const client = await getXGovRegistryClient(signer, activeAddress)

  const builder = client.newGroup()

  for (const pool of pools) {
    const payment = await client.algorand.createTransaction.payment({
      sender: activeAddress,
      receiver: client.appAddress,
      amount: xgovFee.microAlgo(),
      note: `payment for enrolling ${pool} in xGov`,
    })

    builder.requestSubscribeXgov({
      args: {
        xgovAddress: pool,
        ownerAddress: activeAddress,
        relationType: 1,
        payment,
      },
    })
  }

  try {
    const {
      confirmations: [confirmation],
    } = await builder.send({ populateAppCallResources: true })
    await untilReadNodeCaughtUp()

    if (
      confirmation.confirmedRound !== undefined &&
      confirmation.confirmedRound > 0 &&
      confirmation.poolError === ''
    ) {
      setStatus('confirmed')
      await sleep(800)
      setStatus('idle')
      await Promise.all(refetch.map((r) => r()))
      return
    }

    setStatus(new Error('Failed to confirm transaction submission'))
  } catch (e) {
    console.error('Error during requestSubscribeXGov:', (e as Error).message)
    setStatus(new Error(`Failed to request subscription to xGov`))
    return
  }
}
