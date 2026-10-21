import { sdkAt } from '@/api/reti'
import {
  ValidatorNotFoundError,
  ewmaToApy,
  fetchAllValidatorData,
  fetchPoolGlobalStates,
  fetchStakerValidatorData,
  fetchValidatorCoreData,
  fetchNodelyPoolApy,
  processPoolData,
} from '@/api/contracts'
import { LocalPoolInfo, PoolGlobalState } from '@/interfaces/validator'
import { MOCK_EXT_DEPOSITS, MOCK_POOL_APY } from '@/utils/tests/constants'
import { ACCOUNT_1 } from '@/utils/tests/fixtures/accounts'
import { MOCK_STAKED_INFO_1 } from '@/utils/tests/fixtures/boxes'
import {
  MOCK_VALIDATOR_1_CONFIG,
  MOCK_VALIDATOR_1_POOLS,
  MOCK_VALIDATOR_2_CONFIG,
} from '@/utils/tests/fixtures/validators'
import { mockPoolState, mockSdk } from '@/utils/tests/sdk'
import { server } from '@/utils/tests/msw/server'

vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())

const PAST_ROUND = 50_000_000n

function poolFixture(poolAppId: bigint): LocalPoolInfo {
  return { poolId: 1n, poolAppId, totalStakers: 1, totalAlgoStaked: 1_000n }
}

const POOL_STATE: PoolGlobalState = {
  lastPayout: 1000n,
  algodVer: '3.23.1',
  apy: 4.2,
  balance: 40_000_000_000n,
  minBalance: 100_000n,
}

/** Records every request path made through MSW (algod, Nodely...). */
function trackRequests() {
  const paths: string[] = []
  server.events.on('request:start', ({ request }) => {
    paths.push(new URL(request.url).pathname)
  })
  return paths
}

afterEach(() => {
  server.events.removeAllListeners()
  vi.clearAllMocks()
})

describe('fetchAllValidatorData', () => {
  it('reads every validator in one call, at the requested round', async () => {
    const validators = await fetchAllValidatorData(PAST_ROUND)

    expect(sdkAt).toHaveBeenCalledWith(PAST_ROUND)
    expect(mockSdk.getValidators).toHaveBeenCalledTimes(1)
    expect(mockSdk.getValidators).toHaveBeenCalledWith([1, 2], { signal: undefined })
    expect(validators.map((validator) => validator.id)).toEqual([1, 2])
    expect(validators[0].config).toEqual(MOCK_VALIDATOR_1_CONFIG)
    expect(validators[1].config).toEqual(MOCK_VALIDATOR_2_CONFIG)
    expect(validators[0].pools).toEqual(MOCK_VALIDATOR_1_POOLS)
  })

  it('reads the latest state when no round is given', async () => {
    await fetchAllValidatorData()

    expect(sdkAt).toHaveBeenCalledWith(undefined)
  })

  it('returns no validators for an empty registry without reading any', async () => {
    mockSdk.getNumValidators.mockResolvedValueOnce(0)

    expect(await fetchAllValidatorData()).toEqual([])
    expect(mockSdk.getValidators).not.toHaveBeenCalled()
  })
})

describe('fetchValidatorCoreData', () => {
  it('reads one validator', async () => {
    const validator = await fetchValidatorCoreData(1, PAST_ROUND)

    expect(sdkAt).toHaveBeenCalledWith(PAST_ROUND)
    expect(validator.config).toEqual(MOCK_VALIDATOR_1_CONFIG)
  })

  it("throws ValidatorNotFoundError for a validator that doesn't exist (yet)", async () => {
    await expect(fetchValidatorCoreData(99, PAST_ROUND)).rejects.toBeInstanceOf(
      ValidatorNotFoundError,
    )
  })

  it('shares one read between concurrent calls for the same validator and round', async () => {
    mockSdk.getValidators.mockClear()
    // The four per-part queries loading a new round together
    const reads = await Promise.all([
      fetchValidatorCoreData(1, PAST_ROUND),
      fetchValidatorCoreData(1, PAST_ROUND),
      fetchValidatorCoreData(1, PAST_ROUND),
      fetchValidatorCoreData(1, PAST_ROUND),
    ])
    expect(mockSdk.getValidators).toHaveBeenCalledTimes(1)
    // Shared, so no one caller's signal can cancel it
    expect(mockSdk.getValidators).toHaveBeenCalledWith([1])
    expect(new Set(reads).size).toBe(1)

    // Once settled, the next call reads again (the query cache, not this, keeps results)
    await fetchValidatorCoreData(1, PAST_ROUND)
    // Another round is another read
    await fetchValidatorCoreData(1, PAST_ROUND + 1n)
    expect(mockSdk.getValidators).toHaveBeenCalledTimes(3)
  })
})

describe('fetchPoolGlobalStates', () => {
  it('reads every pool in one call and maps its state', async () => {
    mockSdk.getPoolStates.mockResolvedValueOnce([
      mockPoolState(1010n, { lastPayout: 1000n, algodVer: '3.23.1', ewma: 475n }),
      mockPoolState(1011n, { algodVer: '' }),
    ])

    const states = await fetchPoolGlobalStates([1010n, 1011n], PAST_ROUND)

    expect(mockSdk.getPoolStates).toHaveBeenCalledTimes(1)
    expect(states['1010']).toEqual({
      lastPayout: 1000n,
      algodVer: '3.23.1',
      apy: 4.75,
      balance: 40_000_000_000n,
      minBalance: 100_000n,
      roundsPerDay: 30_857n,
    })
    // A pool whose node daemon has never reported has no algodVer
    expect(states['1011']?.algodVer).toBeUndefined()
  })

  it("leaves out pools that don't exist at the round", async () => {
    mockSdk.getPoolStates.mockResolvedValueOnce([
      mockPoolState(1010n),
      mockPoolState(1011n, { exists: false }),
    ])

    const states = await fetchPoolGlobalStates([1010n, 1011n], PAST_ROUND)

    expect(Object.keys(states)).toEqual(['1010'])
  })

  it('makes no call for no pools', async () => {
    expect(await fetchPoolGlobalStates([])).toEqual({})
    expect(mockSdk.getPoolStates).not.toHaveBeenCalled()
  })
})

describe('ewmaToApy', () => {
  it('reads the moving average in hundredths of a percent', () => {
    expect(ewmaToApy(475n)).toBeCloseTo(4.75)
    expect(ewmaToApy(0n)).toBe(0)
  })
})

describe('processPoolData', () => {
  it("takes the pool's spendable balance and on-chain APY from its state, calling nothing", () => {
    const paths = trackRequests()

    const poolData = processPoolData(poolFixture(1010n), POOL_STATE)

    expect(poolData).toEqual({
      poolAppId: 1010n,
      balance: POOL_STATE.balance - POOL_STATE.minBalance,
      lastPayout: 1000n,
      apy: POOL_STATE.apy,
    })
    expect(paths).toEqual([])
  })

  it("corrects the APY for a validator's epochs longer than a day", () => {
    const state = { ...POOL_STATE, apy: 20, roundsPerDay: 30_000n }

    expect(processPoolData(poolFixture(1010n), state, 90_000).apy).toBeCloseTo(20 / 3, 6)
    expect(processPoolData(poolFixture(1010n), state, 30_000).apy).toBe(20)
    expect(processPoolData(poolFixture(1010n), state).apy).toBe(20)
  })

  it('reads as empty for a pool with no state', () => {
    const poolData = processPoolData(poolFixture(1010n), undefined)

    expect(poolData.balance).toBe(0n)
    expect(poolData.lastPayout).toBeUndefined()
  })
})

describe('fetchNodelyPoolApy', () => {
  it("reads the pool's realtime APY and external deposits from Nodely", async () => {
    expect(await fetchNodelyPoolApy(1010n)).toEqual({
      apy: MOCK_POOL_APY,
      extDeposits: MOCK_EXT_DEPOSITS,
    })
  })
})

describe('fetchStakerValidatorData', () => {
  it("groups a staker's positions by validator with each pool's last payout", async () => {
    mockSdk.getPoolStates.mockResolvedValueOnce([mockPoolState(1010n, { lastPayout: 1234n })])

    const data = await fetchStakerValidatorData(ACCOUNT_1, PAST_ROUND)

    expect(sdkAt).toHaveBeenCalledWith(PAST_ROUND)
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      validatorId: 1n,
      balance: MOCK_STAKED_INFO_1.balance,
      totalRewarded: MOCK_STAKED_INFO_1.totalRewarded,
      lastPayout: 1234n,
    })
    expect(data[0].pools[0].poolKey).toEqual({ id: 1n, poolId: 1n, poolAppId: 1010n })
  })

  it('drops duplicate positions in the same pool', async () => {
    const position = {
      staker: ACCOUNT_1,
      validatorId: 1n,
      poolId: 1n,
      poolAppId: 1010n,
      info: MOCK_STAKED_INFO_1,
    }
    mockSdk.getStakerPositions.mockResolvedValueOnce([position, position])

    const data = await fetchStakerValidatorData(ACCOUNT_1)

    expect(data[0].pools).toHaveLength(1)
    expect(data[0].balance).toBe(MOCK_STAKED_INFO_1.balance)
  })
})
