import type { RoundTime } from 'reti-ghost-sdk'
import { describe, expect, it } from 'vitest'
import { roundAsOf, roundAtTime, RoundTimes, spreadRounds, type TimeReader } from '@/api/roundTimes'
import { type Trace, traceQuery } from '@/api/trace'

/** A trace that only runs the requests. */
const quiet: Trace = { step: (_purpose, _params, request) => request(), done: () => {} }

const CREATION = 1_000_000n
const TIP = 21_000_000n
const T0 = 1_700_000_000

/** Block time drifts: 2.9 s for 5M rounds, then 2.8 s for 10M, then 2.85 s. */
const SEGMENTS: [rounds: bigint, seconds: number][] = [
  [5_000_000n, 2.9],
  [10_000_000n, 2.8],
  [TIP, 2.85],
]

function timestampAt(round: bigint): number {
  let seconds = 0
  let from = CREATION
  for (const [length, blockTime] of SEGMENTS) {
    const to = from + length < round ? from + length : round
    if (to > from) seconds += Number(to - from) * blockTime
    from += length
    if (from >= round) break
  }
  return Math.floor(T0 + seconds)
}

/** The answer, by brute-force binary search over the fake chain. */
function firstAtOrAfter(target: number): bigint {
  let lo = CREATION
  let hi = TIP
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (timestampAt(mid) < target) lo = mid + 1n
    else hi = mid
  }
  return lo
}

const point = (round: bigint): RoundTime => ({ round, timestamp: timestampAt(round) })

/** A reader over the fake chain that counts each request. */
function fakeReader() {
  const calls = { timestampsAt: 0, firstRoundAtOrAfter: 0, latest: 0, earliest: 0 }
  const reader: TimeReader = {
    async timestampsAt(rounds) {
      calls.timestampsAt++
      expect(rounds.length).toBeLessThanOrEqual(16)
      return rounds.map(point)
    },
    async firstRoundAtOrAfter(start, target) {
      calls.firstRoundAtOrAfter++
      const end = start + 1000n < TIP ? start + 1000n : TIP
      for (let round = start; round <= end; round++) {
        if (timestampAt(round) >= target) return point(round)
      }
      return undefined
    },
    async latest() {
      calls.latest++
      return point(TIP)
    },
    async earliest() {
      calls.earliest++
      return point(CREATION)
    },
  }
  return { reader, calls }
}

const simulates = (calls: ReturnType<typeof fakeReader>['calls']) =>
  calls.timestampsAt + calls.firstRoundAtOrAfter

describe('RoundTimes', () => {
  it('keeps pairs sorted and distinct', () => {
    const cache = new RoundTimes()
    cache.addAll([point(30n), point(10n), point(20n), point(10n)])
    expect(cache.size).toBe(3)
    expect(cache.get(20n)).toBe(timestampAt(20n))
    expect(cache.get(15n)).toBeUndefined()
    expect(cache.last()?.round).toBe(30n)
  })

  it('brackets a time between the known rounds either side of it', () => {
    const cache = new RoundTimes()
    cache.addAll([
      { round: 10n, timestamp: 100 },
      { round: 20n, timestamp: 200 },
    ])
    expect(cache.bracket(150)).toEqual({
      below: { round: 10n, timestamp: 100 },
      above: { round: 20n, timestamp: 200 },
    })
    // A known round at exactly the time is the first at or after it
    expect(cache.bracket(200).above?.round).toBe(20n)
    expect(cache.bracket(50).below).toBeUndefined()
    expect(cache.bracket(250).above).toBeUndefined()
  })
})

describe('spreadRounds', () => {
  it('spreads distinct rounds over both ends', () => {
    expect(spreadRounds(0n, 30n, 4)).toEqual([0n, 10n, 20n, 30n])
    expect(spreadRounds(0n, 2n, 16)).toEqual([0n, 1n, 2n])
  })
})

describe('roundAtTime', () => {
  const targets = [
    timestampAt(1_000_500n) - 1, // just after creation
    timestampAt(5_999_999n) + 1, // across a change of block time
    timestampAt(13_456_789n),
    timestampAt(20_998_000n) - 2, // near the tip
  ]

  it.each(targets)('finds the first round at or after %i from a cold cache', async (target) => {
    const cache = new RoundTimes()
    const { reader, calls } = fakeReader()
    const result = await roundAtTime(quiet, reader, target, { cache })
    expect(result.round).toBe(firstAtOrAfter(target))
    expect(result.timestamp).toBe(timestampAt(result.round))
    // The two ends, then a few sample passes and one scan
    expect(calls.latest + calls.earliest).toBe(2)
    expect(simulates(calls)).toBeLessThanOrEqual(4)
  })

  it('needs fewer reads once the cache knows the neighbourhood', async () => {
    const cache = new RoundTimes()
    const { reader, calls } = fakeReader()
    const first = timestampAt(13_456_789n)
    await roundAtTime(quiet, reader, first, { cache })
    const before = { ...calls }
    const next = first + 86_400
    const result = await roundAtTime(quiet, reader, next, { cache })
    expect(result.round).toBe(firstAtOrAfter(next))
    expect(calls.latest + calls.earliest).toBe(before.latest + before.earliest)
    expect(simulates(calls) - simulates(before)).toBeLessThanOrEqual(2)
  })

  it('reads nothing when known rounds either side are adjacent', async () => {
    const cache = new RoundTimes()
    cache.addAll([point(CREATION), point(TIP), point(9_999_999n), point(10_000_000n)])
    const { reader, calls } = fakeReader()
    const result = await roundAtTime(quiet, reader, timestampAt(10_000_000n), { cache })
    expect(result.round).toBe(firstAtOrAfter(timestampAt(10_000_000n)))
    expect(calls).toEqual({ timestampsAt: 0, firstRoundAtOrAfter: 0, latest: 0, earliest: 0 })
  })

  it('gives the creation round for a time before it, and the latest for one after it', async () => {
    const cache = new RoundTimes()
    const { reader } = fakeReader()
    expect((await roundAtTime(quiet, reader, T0 - 1000, { cache })).round).toBe(CREATION)
    expect((await roundAtTime(quiet, reader, timestampAt(TIP) + 1000, { cache })).round).toBe(TIP)
  })

  it('waits briefly for a pending read of an end instead of reading it again', async () => {
    const cache = new RoundTimes()
    const { reader, calls } = fakeReader()
    cache.add(TIP, timestampAt(TIP))
    const creation = new Promise<void>((resolve) =>
      setTimeout(() => {
        cache.add(CREATION, timestampAt(CREATION))
        resolve()
      }, 20),
    )
    cache.track(creation, 'earliest')
    const target = timestampAt(13_456_789n)
    expect((await roundAtTime(quiet, reader, target, { cache })).round).toBe(firstAtOrAfter(target))
    expect(calls.earliest).toBe(0)
  })

  it.each([timestampAt(5_999_999n) + 1, timestampAt(13_456_789n), timestampAt(20_000_000n)])(
    'stops at an estimate within the tolerance, after one sample pass (%i)',
    async (target) => {
      const cache = new RoundTimes()
      cache.addAll([point(CREATION), point(TIP)])
      const { reader, calls } = fakeReader()
      const tolerance = 9 * 3600 // half a point of a 3-month chart
      const result = await roundAtTime(quiet, reader, target, { tolerance, cache })
      expect(Math.abs(timestampAt(result.round) - target)).toBeLessThanOrEqual(tolerance)
      expect(calls.timestampsAt).toBe(1)
      expect(calls.firstRoundAtOrAfter).toBe(0)
      // An estimate isn't a read, so it isn't kept
      expect(cache.get(result.round)).toBeUndefined()
    },
  )

  it('reads nothing when the known rounds already give an estimate within the tolerance', async () => {
    const cache = new RoundTimes()
    cache.addAll([point(13_450_000n), point(13_460_000n)])
    const { reader, calls } = fakeReader()
    const target = timestampAt(13_456_789n)
    const result = await roundAtTime(quiet, reader, target, { tolerance: 3600, cache })
    expect(Math.abs(timestampAt(result.round) - target)).toBeLessThanOrEqual(3600)
    expect(simulates(calls)).toBe(0)
  })

  it('reads an end itself when its pending read is slow', async () => {
    const cache = new RoundTimes()
    const { reader, calls } = fakeReader()
    cache.add(TIP, timestampAt(TIP))
    cache.track(new Promise<void>((resolve) => setTimeout(resolve, 1000)), 'earliest')
    const target = timestampAt(13_456_789n)
    expect((await roundAtTime(quiet, reader, target, { cache })).round).toBe(firstAtOrAfter(target))
    expect(calls.earliest).toBe(1)
  })

  it('stops between reads once its signal aborts, with an AbortError', async () => {
    const cache = new RoundTimes()
    const { reader, calls } = fakeReader()
    const controller = new AbortController()
    const sample = reader.timestampsAt
    // The viewer moves on while the first sample pass is in flight
    reader.timestampsAt = async (rounds, signal) => {
      const points = await sample(rounds, signal)
      controller.abort()
      return points
    }
    const target = timestampAt(13_456_789n)

    const search = roundAtTime(traceQuery('test', controller.signal), reader, target, { cache })

    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.timestampsAt).toBe(1)
    expect(calls.firstRoundAtOrAfter).toBe(0)
  })
})

describe('RoundTimes.estimate', () => {
  const cache = new RoundTimes()
  cache.addAll([
    { round: 100n, timestamp: 1_000 },
    { round: 200n, timestamp: 1_300 },
    { round: 300n, timestamp: 1_500 },
  ])

  it('gives a known round its own time', () => {
    expect(cache.estimate(200n)).toBe(1_300)
  })

  it('interpolates between the known rounds either side', () => {
    expect(cache.estimate(150n)).toBe(1_150)
    expect(cache.estimate(250n)).toBe(1_400)
  })

  it('extrapolates from the nearest known round at the average block time', () => {
    // 500 s over 200 rounds: 2.5 s a round
    expect(cache.estimate(400n)).toBe(1_750)
    expect(cache.estimate(60n)).toBe(900)
  })

  it('has no estimate with fewer than two rounds known', () => {
    const one = new RoundTimes()
    expect(one.estimate(5n)).toBeUndefined()
    one.add(10n, 100)
    expect(one.estimate(5n)).toBeUndefined()
  })
})

describe('roundAsOf', () => {
  it('is the round before the first one after the time', () => {
    expect(roundAsOf({ round: 500n, timestamp: 1_002 }, 1_000)).toBe(499n)
  })

  it('is the first round itself when it landed on that very second', () => {
    expect(roundAsOf({ round: 500n, timestamp: 1_000 }, 1_000)).toBe(500n)
  })

  it('is the latest round when the time is after it', () => {
    expect(roundAsOf({ round: 500n, timestamp: 990 }, 1_000)).toBe(500n)
  })

  it("never goes before the registry's first round", () => {
    expect(roundAsOf({ round: 500n, timestamp: 1_002 }, 1_000, 500n)).toBe(500n)
  })
})
