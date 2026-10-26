import algosdk from 'algosdk'
import { Nfd } from '@/interfaces/nfd'
import { ToStringTypes } from '@/interfaces/utils'
import {
  NodePoolAssignmentConfig,
  ValidatorConfig,
  ValidatorCurState,
  ValidatorPoolKey,
} from '@/contracts/ValidatorRegistryClient'

export type EntryGatingAssets = [bigint, bigint, bigint, bigint]
// export type EntryGatingAssets = bigint[]

export type ValidatorConfigInput = Omit<
  ToStringTypes<ValidatorConfig>,
  'id' | 'sunsettingOn' | 'sunsettingTo'
>

export interface LocalPoolInfo {
  poolId: bigint
  poolAppId: bigint
  totalStakers: number
  totalAlgoStaked: bigint
  poolAddress?: string
  apy?: number
}

/**
 * The four pieces of validator state that all live in the single `v` + validatorId box,
 * read for every validator in one batched read (see `fetchAllValidatorData`).
 */
export interface ValidatorCoreData {
  id: number
  config: ValidatorConfig
  state: ValidatorCurState
  pools: LocalPoolInfo[]
  nodePoolAssignment: NodePoolAssignmentConfig
}

export interface NodeConfig {
  poolAppIds: bigint[]
}
// export type NodeConfig = [bigint, ...bigint[]]

export type NodeInfo = {
  index: number
  availableSlots: number
}

export type Validator = {
  id: number
  config: Omit<ValidatorConfig, 'id'>
  state: ValidatorCurState
  pools: LocalPoolInfo[]
  nodePoolAssignment: NodePoolAssignmentConfig
  rewardsBalance?: bigint
  roundsSinceLastPayout?: bigint
  rewardToken?: algosdk.modelsv2.Asset
  gatingAssets?: algosdk.modelsv2.Asset[]
  nfd?: Nfd
  apy?: number
  extDeposits?: number
  perf?: number
}

export interface FindPoolForStakerResponse {
  poolKey: ValidatorPoolKey
  isNewStakerToValidator: boolean
  isNewStakerToProtocol: boolean
}

// Used for calculating validator metrics
export type PoolData = {
  poolAppId?: bigint
  balance: bigint
  lastPayout?: bigint
  apy?: number
  extDeposits?: number
  /** The pool's own count of rounds per day */
  roundsPerDay?: bigint
}

/**
 * The parts of a staking pool's on-chain state the UI reads, all read for every pool in one
 * batched read (see `fetchPoolGlobalStates`).
 */
export type PoolGlobalState = {
  lastPayout?: bigint
  /** Only written once the node daemon reports in */
  algodVer?: string
  /**
   * The pool's on-chain APY in percent, from its moving average. Reads too high for epochs longer
   * than a day: see `epochAdjustedApy`.
   */
  apy: number
  balance: bigint
  minBalance: bigint
  /** The pool's own count of rounds per day, which its moving average works in */
  roundsPerDay?: bigint
}

/**
 * Pools' global states by app id (as a decimal string). A plain object rather than a Map, so a
 * refetch that changes nothing keeps the same object (TanStack Query's structural sharing) and
 * doesn't re-render every observer.
 */
export type PoolGlobalStates = Readonly<Record<string, PoolGlobalState>>
