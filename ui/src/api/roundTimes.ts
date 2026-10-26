import type { RetiGhostSDK, RoundTime } from 'reti-ghost-sdk'
import { isoTime, Trace } from '@/api/trace'

/**
 * Date → round, fast. Every round ↔ timestamp pair the page sees (change history, block headers,
 * reader reads) goes into one in-page cache. A search estimates the round from the cache, narrows
 * it with a read of the timestamps at a list of rounds, then finds the exact round with one last
 * read that scans forward from a round just before the target.
 */

/** Which end of the chain a pending read is known to land on, whatever the target. */
export type SeedSide = 'earliest' | 'latest'

/**
 * The rounds whose timestamps one sample pass reads, in one request. A node that simulates takes
 * up to 256 (one with queries, 16), but each round adds about 1 ms past 64: two passes of 16
 * (75-95 ms each) beat one of 256 (180-330 ms).
 */
export const SAMPLE_ROUNDS = 16

/** The furthest back a program can read a block header. */
export const BLOCK_LOOKBACK = 1000n

/** The longest a search waits for pending reads that would fill in an end of its bracket. */
const PENDING_WAIT_MS = 250

/** The most sample passes a search makes before scanning. Block times are steady: 1-2 is usual. */
const MAX_SAMPLE_PASSES = 6

/**
 * The half-width of a sample pass around its estimate: the estimate's likely error, a share of
 * how far it is from the nearest round with a known time, as block times drift.
 */
const DRIFT = 0.03
const MIN_HALF_WIDTH = 4000n

/** Round ↔ timestamp pairs, sorted by round. Timestamps never decrease as rounds increase. */
export class RoundTimes {
  private points: RoundTime[] = []
  private pending = new Map<Promise<unknown>, SeedSide | undefined>()

  get size(): number {
    return this.points.length
  }

  /** Where `round` is, or would go, in `points`. */
  private indexOf(round: bigint): number {
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid].round < round) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  add(round: bigint, timestamp: number): void {
    const i = this.indexOf(round)
    if (this.points[i]?.round === round) return
    this.points.splice(i, 0, { round, timestamp })
  }

  addAll(points: Iterable<RoundTime>): void {
    for (const { round, timestamp } of points) this.add(round, timestamp)
  }

  /** The latest round with a known time. */
  last(): RoundTime | undefined {
    return this.points[this.points.length - 1]
  }

  get(round: bigint): number | undefined {
    const point = this.points[this.indexOf(round)]
    return point?.round === round ? point.timestamp : undefined
  }

  /**
   * A round's likely block time (seconds), when it can't be read: its own if known, else
   * interpolated between the known rounds either side, else extrapolated from the nearest at
   * the average block time of all known. Undefined with fewer than two rounds known.
   */
  estimate(round: bigint): number | undefined {
    const known = this.get(round)
    if (known !== undefined) return known
    const first = this.points[0]
    const last = this.points[this.points.length - 1]
    if (this.points.length < 2 || last.round === first.round) return undefined
    const i = this.indexOf(round)
    const before = this.points[i - 1]
    const after = this.points[i]
    const [from, to] = before && after ? [before, after] : [first, last]
    const secondsPerRound = (to.timestamp - from.timestamp) / Number(to.round - from.round)
    const nearest = before ?? after
    return Math.round(nearest.timestamp + Number(round - nearest.round) * secondsPerRound)
  }

  /**
   * The known rounds either side of the first round at or after `target` (seconds): `below` is
   * the last known round before it, `above` the first known round at or after it.
   */
  bracket(target: number): { below?: RoundTime; above?: RoundTime } {
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid].timestamp < target) lo = mid + 1
      else hi = mid
    }
    return { below: this.points[lo - 1], above: this.points[lo] }
  }

  /**
   * Notes a read that will add pairs when it settles, so a search can wait for it. `side` says
   * which end of the chain it is known to land on (the registry's creation, the latest round).
   */
  track<T>(promise: Promise<T>, side?: SeedSide): Promise<T> {
    this.pending.set(promise, side)
    const settle = () => this.pending.delete(promise)
    promise.then(settle, settle)
    return promise
  }

  /** Waits up to `ms` for the pending reads known to land on `side`. */
  async settle(side: SeedSide, ms = PENDING_WAIT_MS): Promise<void> {
    const reads = [...this.pending].filter(([, s]) => s === side).map(([p]) => p)
    if (reads.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(reads),
      new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ])
    clearTimeout(timer)
  }

  /** Forgets everything; for tests. */
  clear(): void {
    this.points = []
    this.pending.clear()
  }
}

/** The page's round ↔ time pairs. */
export const roundTimes = new RoundTimes()

/** The reads a search makes. Each is one request, cancelled by `signal`. */
export interface TimeReader {
  /** Each round's block timestamp, in one batched read. Rounds must be before the latest. */
  timestampsAt(rounds: bigint[], signal?: AbortSignal): Promise<RoundTime[]>
  /**
   * The first round from `start` with a timestamp at or after `target`, scanning at most
   * `BLOCK_LOOKBACK` rounds, in one read; undefined if none in that window reaches it.
   * `knownRound`, a round known to exist at or after the answer, saves reading the latest round.
   */
  firstRoundAtOrAfter(
    start: bigint,
    target: number,
    knownRound?: bigint,
    signal?: AbortSignal,
  ): Promise<RoundTime | undefined>
  /** The latest round and its timestamp. */
  latest(signal?: AbortSignal): Promise<RoundTime>
  /** The registry's creation round and its timestamp: the earliest round a search returns. */
  earliest(): Promise<RoundTime | undefined>
}

/** Whether a round's header is already in the SDK's cache, so reading it costs no request. */
function isHeaderCached(sdk: RetiGhostSDK, round: bigint): boolean {
  const headers = (sdk.clock as unknown as { headers?: Map<bigint, unknown> }).headers
  return headers?.has(round) ?? false
}

/**
 * A round's block timestamp (seconds), from the page's pairs or logged as a `round>time` read
 * and kept. `side` marks a read known to land on one end of any search's bracket.
 */
export function timestampOf(
  trace: Trace,
  sdk: RetiGhostSDK,
  round: bigint,
  side?: SeedSide,
): Promise<number> {
  const known = roundTimes.get(round)
  if (known !== undefined) return Promise.resolve(known)
  const read = trace.step(
    'round>time',
    { round, cached: isHeaderCached(sdk, round) },
    async () => {
      // The header read is shared (the SDK caches it), so this caller's signal only stops the wait
      const timestamp = await sdk.timestampOf(round, { signal: trace.signal })
      roundTimes.add(round, timestamp)
      return timestamp
    },
    isoTime,
  )
  return roundTimes.track(read, side)
}

/** `count` distinct rounds spread evenly from `from` to `to`, both included. */
export function spreadRounds(from: bigint, to: bigint, count: number): bigint[] {
  if (to <= from || count < 2) return [from]
  const span = to - from
  const steps = BigInt(count - 1)
  const rounds = new Set<bigint>()
  for (let i = 0n; i <= steps; i++) rounds.add(from + (span * i) / steps)
  return [...rounds]
}

/**
 * The round whose state is the state at `time` (seconds), from {@link roundAtTime}'s answer
 * `first`, the first round at or after it. A page shows the state as of the end of its round, so
 * that's the last round at or before `time`: the round before `first`, unless `first` landed on
 * that very second, or is the registry's first round (`creationRound`).
 */
export function roundAsOf(first: RoundTime, time: number, creationRound?: bigint): bigint {
  const atCreation = creationRound !== undefined && first.round <= creationRound
  return first.timestamp > time && !atCreation ? first.round - 1n : first.round
}

export interface RoundAtTimeOptions {
  /**
   * Seconds the answer may be off by: the search stops once its estimate is likely that close,
   * and returns the estimated round (with `time` as its timestamp) instead of the exact one.
   * Undefined finds the exact round.
   */
  tolerance?: number
  /** The round ↔ time pairs to use; the page's by default. */
  cache?: RoundTimes
}

/**
 * The first round whose block timestamp is at or after `time`: the round on screen from that
 * moment on. A time after the latest block gives the latest round; one before the registry was
 * created gives its creation round, as there is nothing to show before it.
 */
export async function roundAtTime(
  trace: Trace,
  reader: TimeReader,
  time: Date | number,
  { tolerance, cache = roundTimes }: RoundAtTimeOptions = {},
): Promise<RoundTime> {
  const target = time instanceof Date ? Math.ceil(time.getTime() / 1000) : Math.ceil(time)
  const at = isoTime(target)

  return trace.step(
    'time>round',
    { target: at },
    async () => {
      let { below, above } = cache.bracket(target)

      // Pending reads of the ends (the creation round, the latest round) may be about to land
      if (!below) await cache.settle('earliest')
      if (!above) await cache.settle('latest')
      ;({ below, above } = cache.bracket(target))

      // Calibrate: read whichever end is still missing
      if (!above) {
        const latest = await trace.step(
          'time>round',
          { target: at, read: 'latest' },
          () => reader.latest(trace.signal),
          (point) => `round=${point.round} at ${isoTime(point.timestamp)}`,
        )
        cache.add(latest.round, latest.timestamp)
        if (latest.timestamp < target) return latest
      }
      if (!below) {
        const earliest = await trace.step(
          'time>round',
          { target: at, read: 'creation' },
          () => reader.earliest(),
          (point) => (point ? `round=${point.round} at ${isoTime(point.timestamp)}` : 'none'),
        )
        if (earliest) cache.add(earliest.round, earliest.timestamp)
      }
      ;({ below, above } = cache.bracket(target))
      if (!above) throw new Error(`No round at or after ${at}`)
      if (!below) return above

      // Narrow the bracket by sampling around an estimate until the estimate is close enough or
      // a scan can cover the bracket
      for (let pass = 1; above.round - below.round > 1n; pass++) {
        const span = above.round - below.round
        const ratio = (target - below.timestamp) / (above.timestamp - below.timestamp)
        const estimate = below.round + BigInt(Math.round(Number(span) * ratio))
        const nearest =
          estimate - below.round < above.round - estimate
            ? estimate - below.round
            : above.round - estimate
        if (tolerance !== undefined) {
          // The estimate is likely off by the drift in block time since the nearest known round
          const secondsPerRound = (above.timestamp - below.timestamp) / Number(span)
          const error = Number(nearest) * DRIFT * secondsPerRound
          if (error <= tolerance) {
            // An estimate, not a read: kept out of the cache
            return trace.step(
              'time>round',
              { target: at, estimate, error: `~${Math.round(error)}s`, tolerance: `${tolerance}s` },
              async () => ({ round: estimate, timestamp: target }),
              () => 'close enough',
              { summary: true },
            )
          }
        }
        if (span <= BLOCK_LOOKBACK) break
        if (pass > MAX_SAMPLE_PASSES) throw new Error(`No round found for ${at}`)
        const drift = BigInt(Math.ceil(Number(nearest) * DRIFT))
        const half = drift > MIN_HALF_WIDTH ? drift : MIN_HALF_WIDTH
        const from = estimate - half > below.round ? estimate - half : below.round + 1n
        const to = estimate + half < above.round ? estimate + half : above.round - 1n
        const rounds = spreadRounds(from, to, SAMPLE_ROUNDS)
        const read = await trace.step(
          'time>round',
          {
            target: at,
            pass,
            sim: 1,
            estimate,
            rounds: `${rounds.length} (${rounds[0]}…${rounds[rounds.length - 1]})`,
          },
          async () => {
            const points = await reader.timestampsAt(rounds, trace.signal)
            cache.addAll(points)
            return points
          },
          () => {
            const next = cache.bracket(target)
            return `bracket=${next.below?.round}…${next.above?.round}`
          },
        )
        if (read.length === 0) throw new Error(`No block times read for ${at}`)
        ;({ below, above } = cache.bracket(target))
        if (!below || !above) throw new Error(`No round found for ${at}`)
      }

      if (above.round - below.round === 1n) return above

      // Scan forward from the round after the last one known to be before the target
      const start = below.round + 1n
      const found = await trace.step(
        'time>round',
        { target: at, fine: true, sim: 1, start, upTo: above.round },
        // The round above is known to exist and to be at or after the answer
        () => reader.firstRoundAtOrAfter(start, target, above.round, trace.signal),
        (point) => (point ? `round=${point.round} at ${isoTime(point.timestamp)}` : 'none'),
      )
      // Every scanned round was before the target, so the answer is the known round above
      const result = found ?? above
      cache.add(result.round, result.timestamp)
      return result
    },
    ({ round, timestamp }) => `round=${round} at ${isoTime(timestamp)}, known=${cache.size}`,
    { summary: true },
  )
}
