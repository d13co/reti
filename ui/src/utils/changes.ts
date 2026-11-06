import { formatAlgoAmount } from '@/utils/format'
import { getPoolNameFromIndex } from '@/utils/pools'

/**
 * Describes a row of a validator's "Changes" list: what happened at a change round, from the
 * totals at that round and at the round before it.
 */

/** A pool at one round, as far as describing a change needs. */
export interface PoolSnapshot {
  /** Whether the pool app existed at the round */
  exists: boolean
  stakers: bigint
  /** microAlgo */
  staked: bigint
  /** The round of the pool's last epoch payout (its creation round before the first) */
  lastPayout: bigint
  /** The number of payouts the pool has made */
  epochNumber: bigint
}

/** A validator at one round, as far as describing a change needs. */
export interface ChangeSnapshot {
  /** Whether the validator existed at the round */
  exists: boolean
  /** Its stakers, each counted once across its pools */
  stakers: bigint
  /** microAlgo */
  staked: bigint
  /** Its pools in pool order */
  pools: PoolSnapshot[]
}

/**
 * A short description of a validator's change at `round`, from the validator at the round before
 * it (`before`) and at the round itself (`after`); undefined when either couldn't be read.
 *
 *   'Pool 2 · +5,000 ALGO · +1 staker'   'Pool 1 · Epoch 412 payout · +1,830 ALGO'   'Pool 3 added'
 */
export function describeChange(
  round: bigint,
  before?: ChangeSnapshot,
  after?: ChangeSnapshot,
): string | undefined {
  if (!before || !after) return undefined
  if (!before.exists) return 'Validator added'

  const poolIndexes = after.pools.map((_, index) => index)
  const wasThere = (index: number) => !!before.pools[index]?.exists

  const added = poolIndexes.filter((index) => after.pools[index].exists && !wasThere(index))
  if (added.length > 0) return `${poolNames(added)} added`

  // A payout sets the pool's last payout to the round it's made in
  const paid = poolIndexes.filter(
    (index) => wasThere(index) && after.pools[index].lastPayout === round,
  )
  const moved = poolIndexes.filter(
    (index) =>
      wasThere(index) &&
      (after.pools[index].staked !== before.pools[index].staked ||
        after.pools[index].stakers !== before.pools[index].stakers),
  )

  const amounts = [
    after.staked !== before.staked && formatStakeChange(after.staked - before.staked),
    after.stakers !== before.stakers && formatStakersChange(after.stakers - before.stakers),
  ].filter((part): part is string => !!part)

  const parts: string[] = []
  const named = poolIndexes.filter((index) => paid.includes(index) || moved.includes(index))
  if (named.length > 0) {
    // Pools whose stake moved without the validator's totals changing
    if (paid.length === 0 && amounts.length === 0) return `${poolNames(named)} changed`
    parts.push(poolNames(named))
  }
  if (paid.length === 1) parts.push(`Epoch ${after.pools[paid[0]].epochNumber} payout`)
  if (paid.length > 1) parts.push('Epoch payouts')
  parts.push(...amounts)

  if (parts.length === 0) return 'Settings changed'
  return parts.join(' · ')
}

/** 'Pool 2', or 'Pools 1, 3' for several. */
function poolNames(indexes: number[]): string {
  if (indexes.length === 1) return getPoolNameFromIndex(indexes[0])
  return `Pools ${indexes.map((index) => index + 1).join(', ')}`
}

const MINUS = '−'

const sign = (delta: bigint) => (delta < 0n ? MINUS : '+')

const ONE_ALGO = 1_000_000n

/** '+5,000 ALGO', '−0.25 ALGO': whole ALGO from 100 up, cents from 1, else to the microAlgo. */
export function formatStakeChange(delta: bigint): string {
  const amount = delta < 0n ? -delta : delta
  const precision = amount >= 100n * ONE_ALGO ? 0 : amount >= ONE_ALGO ? 2 : 6
  return `${sign(delta)}${formatAlgoAmount(amount, { precision })} ALGO`
}

/** '+1 staker', '−3 stakers'. */
export function formatStakersChange(delta: bigint): string {
  const count = delta < 0n ? -delta : delta
  return `${sign(delta)}${count.toLocaleString()} staker${count === 1n ? '' : 's'}`
}
