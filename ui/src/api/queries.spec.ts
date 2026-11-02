import { QueryClient, QueryObserver } from '@tanstack/react-query'
import algosdk from 'algosdk'
import type { RetiGhostSDK } from 'reti-ghost-sdk'
import {
  allValidatorsQueryOptions,
  nodelyApyQueryOptions,
  poolGlobalStatesQueryOptions,
  realisedApyQueryOptions,
  validatorMetricsQueryOptions,
  validatorPoolStatesQueryOptions,
} from '@/api/queries'
import { sdkAt, timeTravelSupportQueryOptions } from '@/api/reti'
import { LocalPoolInfo, PoolGlobalStates } from '@/interfaces/validator'
import { MOCK_EXT_DEPOSITS, MOCK_POOL_APY } from '@/utils/tests/constants'
import { server } from '@/utils/tests/msw/server'
import { mockSdk } from '@/utils/tests/sdk'

vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())

const pool = (poolAppId: bigint): LocalPoolInfo => ({
  poolId: 1n,
  poolAppId,
  totalStakers: 1,
  totalAlgoStaked: 1_000n,
})

/** Pool 1010 holds 40k ALGO and counts; pool 1011 holds 10k and doesn't. */
const POOLS = [pool(1010n), pool(1011n)]
const STATES: PoolGlobalStates = {
  '1010': { apy: 3.5, balance: 40_000_000_000n, minBalance: 100_000n, lastPayout: 1000n },
  '1011': { apy: 9, balance: 10_000_000_000n, minBalance: 100_000n, lastPayout: 1000n },
}

/** A client whose cache holds the bulk pool state, as the dashboard's would. */
function seededClient() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(poolGlobalStatesQueryOptions(queryClient).queryKey, STATES)
  return queryClient
}

/** Records every Nodely request path. */
function trackNodely() {
  const paths: string[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.hostname.includes('nodely')) paths.push(url.pathname)
  })
  return paths
}

afterEach(() => {
  server.events.removeAllListeners()
})

describe('validatorMetricsQueryOptions', () => {
  it("takes the APY from the pools' on-chain average and never calls Nodely", async () => {
    const queryClient = seededClient()
    const paths = trackNodely()

    const metrics = await queryClient.fetchQuery(
      validatorMetricsQueryOptions(1, queryClient, {
        pools: POOLS,
        totalAlgoStaked: 0n,
        epochRoundLength: 1000,
      }),
    )

    expect(metrics.apy).toBeCloseTo(3.5)
    expect(paths).toEqual([])
  })
})

describe('nodelyApyQueryOptions', () => {
  it('asks Nodely only about the pools the metrics count', async () => {
    const queryClient = seededClient()
    const paths = trackNodely()

    const result = await queryClient.fetchQuery(nodelyApyQueryOptions(1, queryClient, POOLS))

    expect(result).toEqual({ apy: MOCK_POOL_APY, extDeposits: MOCK_EXT_DEPOSITS })
    const address = algosdk.getApplicationAddress(1010n).toString()
    expect(paths).toEqual([`/v1/realtime/reti/pool/${address}/apy`])
  })

  it('is a live key the persister keeps', () => {
    const { queryKey } = nodelyApyQueryOptions(1, new QueryClient(), POOLS)
    expect(queryKey[queryKey.length - 1]).toBe('latest')
  })
})

describe('allValidatorsQueryOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the latest state without a signal, so it is never cancelled', async () => {
    const queryClient = new QueryClient()
    await queryClient.fetchQuery(allValidatorsQueryOptions(queryClient))

    expect(mockSdk.getAllValidators).toHaveBeenCalledWith({ signal: undefined })
  })

  it('cancels a pinned read once nothing shows it, and seeds nothing from it', async () => {
    let release: () => void = () => {}
    mockSdk.getAllValidators.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return mockSdk.getValidators.getMockImplementation()!([1, 2])
    })
    const queryClient = new QueryClient()
    const observer = new QueryObserver(
      queryClient,
      allValidatorsQueryOptions(queryClient, 50_000_000n),
    )
    const unsubscribe = observer.subscribe(() => {})
    await vi.waitFor(() => expect(mockSdk.getAllValidators).toHaveBeenCalled())
    const [options] = mockSdk.getAllValidators.mock.calls[0] as unknown as [
      { signal?: AbortSignal },
    ]
    expect(options.signal).toBeInstanceOf(AbortSignal)

    unsubscribe()
    expect(options.signal?.aborted).toBe(true)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Nothing seeded from a cancelled read
    expect(queryClient.getQueryData(['validator-config', '1', 'round:50000000'])).toBeUndefined()
  })
})

describe('realisedApyQueryOptions', () => {
  const ROUND = 1_000_000n
  const PER_DAY = 30_000n
  /** 30 days before ROUND, by the pool's own rounds per day */
  const START = ROUND - 30n * PER_DAY
  /** Pays out every 3 days */
  const EPOCH = 90_000

  const states: PoolGlobalStates = Object.fromEntries(
    Object.entries(STATES).map(([id, state]) => [id, { ...state, apy: 18, roundsPerDay: PER_DAY }]),
  )
  const staker = (balance: bigint, totalRewarded: bigint) => ({
    slot: 0,
    account: 'A',
    balance,
    totalRewarded,
    rewardTokenBalance: 0n,
    entryRound: 1n,
  })

  /** A node with time travel, and a registry `ageDays` old at ROUND. */
  function client(ageDays = 365n, supported = true) {
    const queryClient = new QueryClient()
    queryClient.setQueryData(poolGlobalStatesQueryOptions(queryClient, ROUND).queryKey, states)
    queryClient.setQueryData(timeTravelSupportQueryOptions.queryKey, {
      supported,
      creationRound: ROUND - ageDays * PER_DAY,
    })
    return queryClient
  }

  /** The staker earned 0.5% between START and ROUND. */
  function stakersEarningHalfAPercent() {
    vi.mocked(sdkAt).mockImplementation(
      (round) =>
        ({
          ...mockSdk,
          getPoolStakers: vi.fn(async () =>
            round === START ? [staker(1_000_000_000n, 0n)] : [staker(1_005_000_000n, 5_000_000n)],
          ),
        }) as unknown as RetiGhostSDK,
    )
  }

  afterEach(() => {
    vi.mocked(sdkAt).mockImplementation(() => mockSdk as unknown as RetiGhostSDK)
  })

  it('annualizes what stakers earned in the last 30 days, for a pool paying out every 3', async () => {
    stakersEarningHalfAPercent()
    const queryClient = client()

    const apy = await queryClient.fetchQuery(
      realisedApyQueryOptions(1, queryClient, { pools: POOLS, epochRoundLength: EPOCH }, ROUND),
    )

    expect(apy).toBeCloseTo(0.5 * (365 / 30), 6)
    expect(vi.mocked(sdkAt).mock.calls.map(([round]) => round)).toEqual(
      expect.arrayContaining([START, ROUND]),
    )
  })

  it('keeps the corrected average when the window holds fewer than two payouts', async () => {
    stakersEarningHalfAPercent()
    // The registry is only 5 days old at ROUND
    const queryClient = client(5n)

    const apy = await queryClient.fetchQuery(
      realisedApyQueryOptions(1, queryClient, { pools: POOLS, epochRoundLength: EPOCH }, ROUND),
    )

    expect(apy).toBeCloseTo(18 / 3, 6)
  })

  it("reads nothing on a node that can't read past rounds", async () => {
    stakersEarningHalfAPercent()
    const queryClient = client(365n, false)
    vi.mocked(sdkAt).mockClear()

    const apy = await queryClient.fetchQuery(
      realisedApyQueryOptions(1, queryClient, { pools: POOLS, epochRoundLength: EPOCH }, ROUND),
    )

    expect(apy).toBeNull()
    expect(sdkAt).not.toHaveBeenCalled()
  })

  it('reads nothing for a validator paying out daily or more often', async () => {
    const queryClient = client()
    mockSdk.getPoolStakers.mockClear()

    const apy = await queryClient.fetchQuery(
      realisedApyQueryOptions(1, queryClient, { pools: POOLS, epochRoundLength: 1000 }, ROUND),
    )

    expect(apy).toBeNull()
    expect(mockSdk.getPoolStakers).not.toHaveBeenCalled()
  })
})

describe('validatorPoolStatesQueryOptions', () => {
  it("keys the read by the pools it reads, so another round's pools can't share it", () => {
    const queryClient = new QueryClient()
    const key = (pools: LocalPoolInfo[]) =>
      validatorPoolStatesQueryOptions(queryClient, 1, pools, 1_000n).queryKey

    expect(key([pool(1010n)])).not.toEqual(key([pool(1010n), pool(1011n)]))
    expect(key(POOLS)).toEqual(key([pool(1010n), pool(1011n)]))
  })
})
