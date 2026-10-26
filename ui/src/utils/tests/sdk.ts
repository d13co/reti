import algosdk from 'algosdk'
import type {
  RegistryTotals,
  RetiGhostSDK,
  SeriesPoint,
  StakerHistory,
  StakerHistoryOptions,
  StakerPoolMembership,
  ValidatorTotals,
} from 'reti-ghost-sdk'
import { AVG_BLOCK_TIME_MS, CURRENT_TIME_MS, LAST_ROUND } from '@/utils/tests/constants'
import { MOCK_STAKED_INFO_1, MOCK_STAKED_INFO_2 } from '@/utils/tests/fixtures/boxes'
import {
  MOCK_CONSTRAINTS,
  MOCK_VALIDATOR_1_CONFIG,
  MOCK_VALIDATOR_1_POOLS,
  MOCK_VALIDATOR_1_POOL_ASSIGNMENT,
  MOCK_VALIDATOR_1_STATE,
  MOCK_VALIDATOR_2_CONFIG,
  MOCK_VALIDATOR_2_POOLS,
  MOCK_VALIDATOR_2_POOL_ASSIGNMENT,
  MOCK_VALIDATOR_2_STATE,
} from '@/utils/tests/fixtures/validators'

/**
 * A stand-in for reti-ghost-sdk, so specs exercise the UI's read layer without simulating the
 * reader contract. Its data mirrors the algod MSW fixtures. Use it with:
 *
 *   vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())
 *
 * and inspect or override calls through `mockSdk` (every method is a `vi.fn`).
 */

const MOCK_VALIDATORS = [
  {
    config: MOCK_VALIDATOR_1_CONFIG,
    state: MOCK_VALIDATOR_1_STATE,
    pools: MOCK_VALIDATOR_1_POOLS,
    nodeAssignment: MOCK_VALIDATOR_1_POOL_ASSIGNMENT,
  },
  {
    config: MOCK_VALIDATOR_2_CONFIG,
    state: MOCK_VALIDATOR_2_STATE,
    pools: MOCK_VALIDATOR_2_POOLS,
    nodeAssignment: MOCK_VALIDATOR_2_POOL_ASSIGNMENT,
  },
]

/** Each pool's stakers: validator 1's first pool holds both mock stakers, every other is empty. */
export const MOCK_POOL_STAKERS: Record<string, (typeof MOCK_STAKED_INFO_1)[]> = {
  '1010': [MOCK_STAKED_INFO_1, MOCK_STAKED_INFO_2],
}

const MOCK_MBR_AMOUNTS = {
  addValidatorMbr: 442_900n,
  addPoolMbr: 963_500n,
  poolInitMbr: 5_225_300n,
  addStakerMbr: 74_100n,
}

/** A pool's global state as the SDK reads it, before the UI's mapping. */
export function mockPoolState(poolAppId: bigint, overrides: Record<string, unknown> = {}) {
  return {
    poolAppId,
    exists: true,
    validatorId: 1n,
    poolId: 1n,
    numStakers: 2n,
    staked: 1_000_000n,
    minEntryStake: 1_000_000n,
    lastPayout: 1_000n,
    epochNumber: 1n,
    algodVer: '',
    roundsPerDay: 30_857n,
    binRoundStart: 0n,
    rewardAccumulator: 0n,
    stakeAccumulator: 0n,
    ewma: 420n,
    balance: 40_000_000_000n,
    minBalance: 100_000n,
    ...overrides,
  }
}

/** A series point's block time in the mock: round 0 at 1,700,000,000 s, a block every 2.8 s. */
export const mockTimestampAt = (round: bigint) => 1_700_000_000 + Math.floor(Number(round) * 2.8)

function createMockSdk() {
  const sdk = {
    getNumValidators: vi.fn(async () => MOCK_VALIDATORS.length),
    getRegistryTotals: vi.fn(async () => ({
      numValidators: MOCK_VALIDATORS.length,
      numStakers: 2n,
      staked: 0n,
    })),
    getValidators: vi.fn(async (ids: (number | bigint)[]) =>
      ids.map((id) => {
        const validator = MOCK_VALIDATORS[Number(id) - 1]
        if (!validator) {
          // Like the reader: a validator that doesn't exist reads as zeros
          return {
            config: { ...MOCK_VALIDATOR_1_CONFIG, id: 0n },
            state: MOCK_VALIDATOR_1_STATE,
            poolInfo: [],
            nodeAssignment: MOCK_VALIDATOR_1_POOL_ASSIGNMENT,
          }
        }
        return {
          config: validator.config,
          state: validator.state,
          poolInfo: validator.pools.map((pool): [bigint, number, bigint] => [
            pool.poolAppId,
            pool.totalStakers,
            pool.totalAlgoStaked,
          ]),
          nodeAssignment: validator.nodeAssignment,
        }
      }),
    ),
    getPoolStates: vi.fn(async (poolAppIds: (number | bigint)[]) =>
      poolAppIds.map((id) => mockPoolState(BigInt(id))),
    ),
    getPoolStakers: vi.fn(async (poolAppId: number | bigint) =>
      (MOCK_POOL_STAKERS[String(poolAppId)] ?? []).map((staker, slot) => ({ slot, ...staker })),
    ),
    getStakerPositions: vi.fn(async (stakers: string[]) =>
      stakers.flatMap((staker) =>
        Object.entries(MOCK_POOL_STAKERS).flatMap(([poolAppId, infos]) =>
          infos
            .filter((info) => info.account === staker)
            .map((info) => ({
              staker,
              validatorId: 1n,
              poolId: 1n,
              poolAppId: BigInt(poolAppId),
              info,
            })),
        ),
      ),
    ),
    getAccountBalances: vi.fn(async (accounts: string[]) =>
      accounts.map((account) => ({ account, balance: 40_000_000_000n, minBalance: 100_000n })),
    ),
    getAssetHoldings: vi.fn(async (holdings: { account: string; assetId: number | bigint }[]) =>
      holdings.map(({ account, assetId }) => ({
        account,
        assetId: BigInt(assetId),
        optedIn: true,
        balance: 0n,
      })),
    ),
    getAssets: vi.fn(async (assetIds: (number | bigint)[]) =>
      assetIds.map((id) => ({
        index: BigInt(id),
        params: {
          creator: algosdk.encodeAddress(new Uint8Array(32)),
          total: 1_000_000n,
          decimals: 6,
          unitName: 'MOCK',
          name: 'Mock Asset',
        },
      })),
    ),
    getMbrAmountsAndProtocolConstraints: vi.fn(async () => ({
      mbrAmounts: MOCK_MBR_AMOUNTS,
      constraints: MOCK_CONSTRAINTS,
    })),
    /** The `num` blocks before the last round, spaced like the algod MSW block fixture. */
    getBlockTimestamps: vi.fn(async (num: number) =>
      Array.from({ length: num }, (_, i) => {
        const round = LAST_ROUND - num + i
        const offset = (LAST_ROUND - round) * AVG_BLOCK_TIME_MS
        return BigInt(Math.round((CURRENT_TIME_MS - offset) / 1000))
      }),
    ),
    timestampOf: vi.fn(async () => Math.round(CURRENT_TIME_MS / 1000)),
    /** Every round reads, with one validator and a block every 2.8 s from round 0 at T0 */
    getRegistryTotalsSeries: vi.fn(
      async (rounds: (number | bigint)[]): Promise<SeriesPoint<RegistryTotals>[]> =>
        rounds.map((round) => ({
          round: BigInt(round),
          ok: true as const,
          value: { numValidators: 1, numStakers: BigInt(round) % 100n, staked: 1_000_000n },
          timestamp: mockTimestampAt(BigInt(round)),
        })),
    ),
    getValidatorTotalsSeries: vi.fn(
      async (
        validatorIds: (number | bigint)[],
        rounds: (number | bigint)[],
      ): Promise<SeriesPoint<ValidatorTotals[]>[]> =>
        rounds.map((round) => ({
          round: BigInt(round),
          ok: true as const,
          value: validatorIds.map((validatorId) => ({
            validatorId: BigInt(validatorId),
            numPools: 1n,
            totalStakers: 2n,
            totalAlgoStaked: 5_000_000n,
          })),
          timestamp: mockTimestampAt(BigInt(round)),
        })),
    ),
    /** No changes on record */
    getChangeRounds: vi.fn(async () => ({ changes: [] })),
    /** Never staked */
    getStakerPools: vi.fn(
      async (_staker: string, _options?: { maxRound?: number | bigint }) =>
        [] as StakerPoolMembership[],
    ),
    getStakerHistory: vi.fn(
      async (_staker: string, _options?: StakerHistoryOptions): Promise<StakerHistory> => ({
        events: [],
        pools: [],
        round: BigInt(LAST_ROUND),
      }),
    ),
    supportsTimeTravel: vi.fn(async () => true),
    getRegistryCreationRound: vi.fn(async () => 1n),
    getNode: vi.fn(async () => ({
      kind: 'dt' as const,
      limits: {
        maxTxnGroups: 16,
        maxRounds: 256,
        maxExtraOpcodeBudget: 640_000,
        resourceLimitMultiplier: 128,
        timeTravel: true,
        developerApi: true,
      },
      query: {
        maxCalls: 1024,
        maxRounds: 16,
        maxCallBudget: 320_000,
        maxCallLogBytes: 65_536,
        maxResponseBytes: 67_108_864,
      },
    })),
    prefetch: vi.fn(async () => {}),
    atRound: vi.fn(() => sdk),
  }
  return sdk
}

/** The fake SDK every `sdkAt(round)` returns. */
export const mockSdk = createMockSdk()

/** A replacement for the `@/api/reti` module. */
export function mockRetiModule() {
  return {
    retiSdk: mockSdk as unknown as RetiGhostSDK,
    readAlgorand: undefined,
    sdkAt: vi.fn(() => mockSdk as unknown as RetiGhostSDK),
    registryCreation: vi.fn(async () => undefined),
    latestReadRound: vi.fn(async () => BigInt(LAST_ROUND)),
    untilReadNodeCaughtUp: vi.fn(async () => {}),
    timeReader: {
      timestampsAt: vi.fn(async () => []),
      firstRoundAtOrAfter: vi.fn(async () => undefined),
      latest: vi.fn(async () => ({ round: 1n, timestamp: Math.round(CURRENT_TIME_MS / 1000) })),
      earliest: vi.fn(async () => undefined),
    },
    timeTravelSupportQueryOptions: {
      queryKey: ['time-travel-support'],
      queryFn: async () => ({ supported: false }),
    },
    roundTimestampQueryOptions: (round?: bigint) => ({
      queryKey: ['round-timestamp', round?.toString()],
      queryFn: () => mockSdk.timestampOf(),
      enabled: round !== undefined,
    }),
  }
}

/** A replacement for `@/hooks/useAtRound`: live (no round), with `writeAddress` writes. */
export function mockAtRoundModule(round?: bigint, writeAddress: string | null = null) {
  return {
    useAtRound: () => ({ round, pinned: round !== undefined }),
    useWriteAddress: () => (round === undefined ? writeAddress : null),
    useViewedTime: () => undefined,
  }
}
