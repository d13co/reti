import { queryOptions, QueryClient } from '@tanstack/react-query'
import { latestReadRound, retiSdk } from '@/api/reti'
import { PERSISTED_GC_TIME } from '@/lib/queryPersister'
import { AlgodVerChange, CHANGE_SPAN_ROUNDS } from '@/utils/upgrades'

/**
 * Node upgrade history: when each pool's node daemon wrote a new `algodVer`, from the pool's
 * versions on a dtalgorand node filtered to that key, each with its new value.
 */

/** A pool's `algodVer` changes from `minRound` to `maxRound`, oldest first. */
function fetchAlgodVerChanges(
  poolAppId: bigint,
  minRound: bigint,
  maxRound: bigint,
  signal?: AbortSignal,
): Promise<AlgodVerChange[]> {
  return retiSdk.getPoolAlgodVersionChanges(poolAppId, { minRound, maxRound, signal })
}

/** A pool's version changes over a span of rounds, scanned up to `to`. */
export interface PoolAlgodChanges {
  /** The last round scanned, inclusive: the span's end once it has passed */
  to: bigint
  changes: AlgodVerChange[]
}

/** How long a span still being written to is fresh, before a visit scans its new rounds. */
const OPEN_SPAN_STALE_TIME = 1000 * 60 * 5 // 5 minutes

/**
 * One pool's version changes over the span of rounds starting at `spanStart` (see
 * `CHANGE_SPAN_ROUNDS`). A span that ended never changes, so it is read once; the one still
 * being written to is extended from where its last scan stopped.
 */
export const poolAlgodChangesQueryOptions = (
  queryClient: QueryClient,
  poolAppId: bigint,
  spanStart: bigint,
) => {
  const spanEnd = spanStart + CHANGE_SPAN_ROUNDS - 1n
  const queryKey = ['pool-algod-changes', String(poolAppId), String(spanStart)] as const
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<PoolAlgodChanges> => {
      const previous = queryClient.getQueryData<PoolAlgodChanges>(queryKey)
      if (previous && previous.to >= spanEnd) return previous
      // The node lists a round's versions as it reports the round, so the scan reaches the latest
      const latest = await latestReadRound()
      const to = latest < spanEnd ? latest : spanEnd
      const from = previous ? previous.to + 1n : spanStart
      // Nothing new yet; a span not reached yet is scanned up to just before its start
      if (from > to) return previous ?? { to: spanStart - 1n, changes: [] }
      const found = await fetchAlgodVerChanges(poolAppId, from, to, signal)
      return { to, changes: [...(previous?.changes ?? []), ...found] }
    },
    staleTime: (query) => {
      const data = query.state.data
      if (!data) return 0
      return data.to >= spanEnd ? Infinity : OPEN_SPAN_STALE_TIME
    },
    gcTime: PERSISTED_GC_TIME,
    retry: 2,
  })
}

/**
 * Every listed pool's `algodVer` at the end of `round`, by pool app id: empty for a pool that had
 * none or didn't exist. One read; the state at a past round never changes.
 */
export const poolAlgodVersionsAtQueryOptions = (poolAppIds: bigint[], round: bigint) =>
  queryOptions({
    queryKey: ['pool-algod-versions-at', String(round), poolAppIds.join(',')],
    queryFn: async ({ signal }): Promise<Record<string, string>> => {
      const versions = await retiSdk.getPoolAlgodVersions(poolAppIds, { round, signal })
      return Object.fromEntries(poolAppIds.map((id, i) => [String(id), versions[i] ?? '']))
    },
    staleTime: Infinity,
    gcTime: PERSISTED_GC_TIME,
  })
