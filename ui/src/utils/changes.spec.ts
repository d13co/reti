import {
  type ChangeSnapshot,
  describeChange,
  formatStakeChange,
  formatStakersChange,
  type PoolSnapshot,
} from '@/utils/changes'

const ROUND = 1_000n
const ALGO = 1_000_000n

const pool = (overrides: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
  exists: true,
  stakers: 2n,
  staked: 10_000n * ALGO,
  lastPayout: 900n,
  epochNumber: 41n,
  ...overrides,
})

/** A validator whose totals are its pools' sums (each staker in one pool). */
const validator = (pools: PoolSnapshot[], overrides: Partial<ChangeSnapshot> = {}) => ({
  exists: true,
  stakers: pools.reduce((sum, p) => sum + p.stakers, 0n),
  staked: pools.reduce((sum, p) => sum + p.staked, 0n),
  pools,
  ...overrides,
})

describe('describeChange', () => {
  it('names the pool and the stake and stakers that came in', () => {
    const before = validator([pool(), pool()])
    const after = validator([pool(), pool({ stakers: 3n, staked: 15_000n * ALGO })])
    expect(describeChange(ROUND, before, after)).toBe('Pool 2 · +5,000 ALGO · +1 staker')
  })

  it('gives the stake and stakers that left', () => {
    const before = validator([pool({ stakers: 3n, staked: 22_400n * ALGO })])
    const after = validator([pool({ stakers: 2n, staked: 10_000n * ALGO })])
    expect(describeChange(ROUND, before, after)).toBe('Pool 1 · −12,400 ALGO · −1 staker')
  })

  it('leaves out stakers when only the stake moved', () => {
    const before = validator([pool()])
    const after = validator([pool({ staked: 10_000n * ALGO - 250_000n })])
    expect(describeChange(ROUND, before, after)).toBe('Pool 1 · −0.25 ALGO')
  })

  it('names every pool that moved in one round', () => {
    const before = validator([pool(), pool(), pool()])
    const after = validator([
      pool({ stakers: 3n, staked: 12_000n * ALGO }),
      pool(),
      pool({ stakers: 3n, staked: 13_000n * ALGO }),
    ])
    expect(describeChange(ROUND, before, after)).toBe('Pools 1, 3 · +5,000 ALGO · +2 stakers')
  })

  it('counts the validator’s stakers, not its pools’', () => {
    // A staker already in pool 1 joins pool 2: the validator's count holds
    const before = validator([pool(), pool()])
    const after = validator([pool(), pool({ stakers: 3n, staked: 11_000n * ALGO })], {
      stakers: 4n,
    })
    expect(describeChange(ROUND, before, after)).toBe('Pool 2 · +1,000 ALGO')
  })

  it('tells an epoch payout from a deposit by the pool’s last payout round', () => {
    const before = validator([pool(), pool()])
    const paid = validator([
      pool({ staked: 10_012n * ALGO, lastPayout: ROUND, epochNumber: 42n }),
      pool(),
    ])
    const deposited = validator([pool({ staked: 10_012n * ALGO }), pool()])
    expect(describeChange(ROUND, before, paid)).toBe('Pool 1 · Epoch 42 payout · +12 ALGO')
    expect(describeChange(ROUND, before, deposited)).toBe('Pool 1 · +12 ALGO')
  })

  it('shows several payouts in one round, and a payout with no reward', () => {
    const before = validator([pool(), pool()])
    const bothPaid = validator([
      pool({ staked: 10_012n * ALGO, lastPayout: ROUND, epochNumber: 42n }),
      pool({ staked: 10_008n * ALGO, lastPayout: ROUND, epochNumber: 17n }),
    ])
    expect(describeChange(ROUND, before, bothPaid)).toBe('Pools 1, 2 · Epoch payouts · +20 ALGO')
    const noReward = validator([pool({ lastPayout: ROUND, epochNumber: 42n }), pool()])
    expect(describeChange(ROUND, before, noReward)).toBe('Pool 1 · Epoch 42 payout')
  })

  it('says which pool was added', () => {
    const before = validator([pool(), pool(), pool({ exists: false, stakers: 0n, staked: 0n })])
    const after = validator([pool(), pool(), pool({ stakers: 0n, staked: 0n, lastPayout: ROUND })])
    expect(describeChange(ROUND, before, after)).toBe('Pool 3 added')
  })

  it('calls a change that moved no totals a settings change', () => {
    expect(describeChange(ROUND, validator([pool()]), validator([pool()]))).toBe('Settings changed')
  })

  it('names pools whose stake moved when the validator’s totals held', () => {
    const before = validator([pool(), pool()])
    const after = validator([pool({ staked: 9_000n * ALGO }), pool({ staked: 11_000n * ALGO })])
    expect(describeChange(ROUND, before, after)).toBe('Pools 1, 2 changed')
  })

  it('calls the change at which the validator first exists its addition', () => {
    const missing = validator([], { exists: false, stakers: 0n, staked: 0n })
    expect(describeChange(ROUND, missing, validator([]))).toBe('Validator added')
  })

  it('has nothing to say when either round failed to read', () => {
    const snapshot = validator([pool()])
    expect(describeChange(ROUND, undefined, snapshot)).toBeUndefined()
    expect(describeChange(ROUND, snapshot, undefined)).toBeUndefined()
  })
})

describe('formatStakeChange', () => {
  it('signs the amount and rounds it to what matters at its size', () => {
    expect(formatStakeChange(5_000n * ALGO)).toBe('+5,000 ALGO')
    expect(formatStakeChange(-12_400_400_000n)).toBe('−12,400 ALGO')
    expect(formatStakeChange(38_914_000n)).toBe('+38.91 ALGO')
    expect(formatStakeChange(-1_234n)).toBe('−0.001234 ALGO')
  })
})

describe('formatStakersChange', () => {
  it('signs the count and agrees in number', () => {
    expect(formatStakersChange(1n)).toBe('+1 staker')
    expect(formatStakersChange(-3n)).toBe('−3 stakers')
  })
})
