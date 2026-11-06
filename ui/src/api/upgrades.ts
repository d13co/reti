import { queryOptions, QueryClient } from '@tanstack/react-query'
import { latestReadRound, retiSdk } from '@/api/reti'
import { traceRead } from '@/api/trace'
import {
  restoreAlgodHistories,
  saveAlgodHistory,
  StoredAlgodHistory,
} from '@/lib/algodHistoryStore'
import { PERSISTED_GC_TIME } from '@/lib/queryPersister'
import { retryRead } from '@/utils/readErrors'
import { AlgodVerChange } from '@/utils/upgrades'

/**
 * Node upgrade history: when each pool's node daemon wrote a new `algodVer`, from the pool's
 * versions on a dtalgorand node filtered to that key, each with its new value.
 */

/**
 * A pool's `algodVer` changes up to `maxRound`, oldest first: from `minRound`, or from its
 * creation. The node lists them in pages (short ones when it nears its own time limit), which the
 * SDK follows.
 */
function fetchAlgodVerChanges(
  poolAppId: bigint,
  minRound: bigint | undefined,
  maxRound: bigint,
  signal?: AbortSignal,
): Promise<AlgodVerChange[]> {
  return retiSdk.getPoolAlgodVersionChanges(poolAppId, { minRound, maxRound, signal })
}

/** A pool's version changes from its creation, listed up to `to`. */
export interface PoolAlgodChanges {
  /** The last round listed, inclusive */
  to: bigint
  changes: AlgodVerChange[]
}

/** How long a pool's history is fresh, before a visit lists its new rounds. */
const HISTORY_STALE_TIME = 1000 * 60 * 5 // 5 minutes

/**
 * How many of the latest rounds a listing leaves for the next one. A listing is never repeated, so
 * one that reached past what the node has taken in yet would miss those rounds for good.
 */
const LISTING_MARGIN = 4n

export const poolAlgodChangesQueryKey = (poolAppId: bigint) =>
  ['pool-algod-changes', String(poolAppId)] as const

/**
 * One pool's whole version history. The first read lists it from the pool's creation; later ones
 * list only the rounds since the last, so a history is read once and then extended. Any window
 * on screen is a filter over it. Kept in IndexedDB (see `algodHistoryStore`, which decides when
 * it's worth a write).
 */
export const poolAlgodChangesQueryOptions = (queryClient: QueryClient, poolAppId: bigint) => {
  const queryKey = poolAlgodChangesQueryKey(poolAppId)
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<PoolAlgodChanges> => {
      const previous = queryClient.getQueryData<PoolAlgodChanges>(queryKey)
      // The node lists a round's versions as it reports the round, so the listing reaches about
      // the latest
      const latest = await latestReadRound()
      const to = latest > LISTING_MARGIN ? latest - LISTING_MARGIN : 0n
      const from = previous ? previous.to + 1n : undefined
      if (previous && from !== undefined && from > to) return previous
      const found = await traceRead(
        'pool-algod-changes',
        'fetchAlgodVerChanges',
        { pool: poolAppId, from, to },
        () => fetchAlgodVerChanges(poolAppId, from, to, signal),
        (changes) => `changes=${changes.length}`,
        signal,
      )
      const changes =
        previous && found.length > 0
          ? [...previous.changes, ...found]
          : // Nothing new keeps the same array, which can run to tens of thousands of changes
            (previous?.changes ?? found)
      const history = { to, changes }
      saveAlgodHistory(retiSdk.registryAppId, poolAppId, history)
      return history
    },
    staleTime: HISTORY_STALE_TIME,
    gcTime: PERSISTED_GC_TIME,
    retry: (failureCount, error) => failureCount < 2 && retryRead(failureCount, error),
  })
}

/** How long the page waits for the kept histories before listing the pools without them. */
const RESTORE_TIMEOUT = 1000 * 2 // 2 seconds

/**
 * Puts kept histories in the cache, each as of when it was listed: one listed long enough ago is
 * stale and gets extended. A history already in the cache that reaches as far is left alone.
 * Returns how many it put in.
 */
function seedAlgodHistories(
  queryClient: QueryClient,
  kept: Map<bigint, StoredAlgodHistory>,
): number {
  let restored = 0
  for (const [poolAppId, { to, changes, savedAt }] of kept) {
    const options = poolAlgodChangesQueryOptions(queryClient, poolAppId)
    const cached = queryClient.getQueryData<PoolAlgodChanges>(options.queryKey)
    if (cached && cached.to >= to) continue
    // Built from the pool's own options, not `setQueryData`'s defaults, so it keeps their gcTime:
    // nothing observes these queries, and the default 5 minutes would drop them mid-visit
    queryClient
      .getQueryCache()
      .build(queryClient, queryClient.defaultQueryOptions(options))
      .setData({ to, changes }, { updatedAt: savedAt, manual: true })
    restored++
  }
  return restored
}

/**
 * Loads the kept pool histories into the cache, once per page load. Resolves to how many were
 * loaded; never rejects. Past the timeout it resolves 0 so the pools get listed, and loads them
 * when they come anyway: the pools not listed yet then extend what was kept, rather than every pool
 * being listed and rewritten from its creation on every slow visit.
 */
export const algodHistoriesRestoreQueryOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: ['pool-algod-changes-restore', String(retiSdk.registryAppId)],
    queryFn: async (): Promise<number> => {
      const restoring = restoreAlgodHistories(retiSdk.registryAppId).catch(() => undefined)
      const timedOut = Symbol('timed out')
      const kept = await Promise.race([
        restoring,
        new Promise<typeof timedOut>((resolve) =>
          setTimeout(() => resolve(timedOut), RESTORE_TIMEOUT),
        ),
      ])
      if (kept === timedOut) {
        void restoring.then((late) => late && seedAlgodHistories(queryClient, late))
        return 0
      }
      return kept ? seedAlgodHistories(queryClient, kept) : 0
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
