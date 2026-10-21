import { FutureRoundError, RetiNotDeployedError, TimeTravelUnavailableError } from 'reti-ghost-sdk'

/**
 * Time travel: every protocol read can be pinned to a past round. Query keys carry the round as
 * their last element, so live and historical data never share a cache entry.
 */

/** The key element for reads at the latest round. */
export const LATEST_ROUND_KEY = 'latest'

/** Prefix of the key element for a read pinned to a round, so it can't be mistaken for an id. */
const PINNED_ROUND_KEY_PREFIX = 'round:'

/** The query key element for a read at `round`, or at the latest round when undefined. */
export function roundKey(round?: bigint): string {
  return round === undefined ? LATEST_ROUND_KEY : `${PINNED_ROUND_KEY_PREFIX}${round}`
}

/** Whether a query key belongs to a read pinned to a past round. */
export function isPinnedQueryKey(queryKey: readonly unknown[]): boolean {
  const last = queryKey[queryKey.length - 1]
  return typeof last === 'string' && last.startsWith(PINNED_ROUND_KEY_PREFIX)
}

/**
 * How long a pinned read stays cached once nothing shows it. Each visited round holds a whole
 * page of reads, and scrubbing through history visits many, so they go well before live data.
 */
export const PINNED_GC_TIME = 1000 * 60 * 10 // 10 minutes

/**
 * Query options for a read at `round`. The state at a past round never changes, so a pinned
 * read is fetched once and never refetched, and is dropped after {@link PINNED_GC_TIME} unused;
 * live reads keep their own polling and cache options.
 */
export function roundQueryDefaults<T extends object>(round: bigint | undefined, live: T) {
  if (round === undefined) {
    return live
  }
  return {
    ...live,
    gcTime: PINNED_GC_TIME,
    staleTime: Infinity,
    refetchInterval: false as const,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  }
}

/**
 * The query's abort signal for a read pinned to a past round; undefined for the latest state.
 *
 * Reading a query's `signal` is what makes TanStack Query cancel it once nothing shows it any
 * more (another round, another page). Pinned reads are worth cancelling: stepping through rounds
 * would otherwise finish a page of reads for every round passed. Live reads are polled and shared
 * across pages, so they never read it.
 */
export function pinnedSignal(
  round: bigint | undefined,
  context: { signal: AbortSignal },
): AbortSignal | undefined {
  return round === undefined ? undefined : context.signal
}

/**
 * Query options that keep showing the previous data while the query loads at another round, but
 * only if the previous key is the same read at a different round (its last element). A
 * different validator, pool or asset starts empty instead of showing the wrong one's data.
 *
 *   useQuery(keepAcrossRounds(validatorStateQueryOptions(id, round)))
 *
 * The query's `isPlaceholderData` then says the data on screen is from the previous round.
 */
export function keepAcrossRounds<O extends { queryKey: readonly unknown[] }>(options: O): O {
  const read = JSON.stringify(options.queryKey.slice(0, -1))
  const placeholderData = (
    previousData: unknown,
    previousQuery?: { queryKey: readonly unknown[] },
  ): unknown =>
    previousQuery && JSON.stringify(previousQuery.queryKey.slice(0, -1)) === read
      ? previousData
      : undefined
  return { ...options, placeholderData }
}

/**
 * Whether a read failed because its round can't be shown at all: before Réti existed, past the
 * read node's latest round, or too old for a node without time travel. That's an answer, not a
 * failure, so it is never retried.
 */
export function isRoundUnavailable(
  error: unknown,
): error is RetiNotDeployedError | FutureRoundError | TimeTravelUnavailableError {
  return (
    error instanceof RetiNotDeployedError ||
    error instanceof FutureRoundError ||
    error instanceof TimeTravelUnavailableError
  )
}

/** What to tell the viewer when {@link isRoundUnavailable}. */
export function roundUnavailableMessage(error: Error): string {
  if (error instanceof FutureRoundError) {
    return `Round ${error.round.toLocaleString()} hasn't happened yet. The latest round is ${error.lastRound.toLocaleString()}.`
  }
  if (error instanceof TimeTravelUnavailableError) {
    return `Round ${error.round.toLocaleString()} can't be shown: this node only serves the latest state.`
  }
  return error.message
}

/** The default query retry: three tries, none for a round that can't be shown. */
export function retryUnlessRoundUnavailable(failureCount: number, error: Error): boolean {
  return failureCount < 3 && !isRoundUnavailable(error)
}

/** Parses a `?round=` value: a positive integer, else undefined. */
export function parseRound(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') {
    return value > 0n ? value : undefined
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const round = BigInt(value.trim())
    return round > 0n ? round : undefined
  }
  return undefined
}
