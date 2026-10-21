import { QueryClient } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createRootRouteWithContext, Outlet, retainSearchParams } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'
import { blockTimeQueryOptions, constraintsQueryOptions, mbrQueryOptions } from '@/api/queries'
import { roundTimestampQueryOptions } from '@/api/reti'
import { roundTimes } from '@/api/roundTimes'
import { Layout } from '@/components/Layout'
import { useCheckForUpdates } from '@/hooks/useCheckForUpdates'
import { resetExtrasReady } from '@/hooks/useExtrasReady'
import { setViewedTime } from '@/utils/contracts'
import { parseRound, roundKey } from '@/utils/round'

/** Search params every route accepts. */
export interface RootSearch {
  /** Time travel: show every page as of the end of this round, read-only. */
  round?: number
}

/** Whether the app has yet to finish its first load. */
let firstLoad = true
/** The round the latest navigation asked for, as of its loader. */
let viewedRound: bigint | undefined
/** The round the latest navigation asked for, as of its `beforeLoad` (the first thing it runs). */
let requestedRound: bigint | undefined
/** Whether a navigation has run its `beforeLoad` yet. */
let navigated = false

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
  walletManager: { activeAddress: string | null }
}>()({
  validateSearch: (search: Record<string, unknown>): RootSearch => {
    const round = parseRound(search.round)
    return round === undefined ? {} : { round: Number(round) }
  },
  search: {
    // Links and navigations keep the round, so time travelling sticks until it's turned off
    middlewares: [retainSearchParams<RootSearch>(['round'])],
  },
  beforeLoad: ({ context: { queryClient }, search }) => {
    // Reads every page needs. Started here rather than in the loader so they go out alongside
    // the routes' own `beforeLoad` reads (the dashboard's validator set) instead of after them.
    // Not awaited: pages that need them suspend on them.
    const round = parseRound(search.round)

    // Moving to another round: the previous one's reads that nothing shows are no longer wanted.
    // Here rather than in the loader, which only runs once every route's `beforeLoad` is done
    // (the dashboard's waits for the validator set), by when they would have finished anyway.
    const previousRound = requestedRound
    const roundChanged = navigated && previousRound !== round
    navigated = true
    requestedRound = round
    if (roundChanged) {
      // The new round's own reads and charts go first again, then its extras
      resetExtrasReady()
      if (previousRound !== undefined) cancelUnseenReads(queryClient, previousRound)
    }

    void queryClient.prefetchQuery(blockTimeQueryOptions(round))
    void queryClient.prefetchQuery(constraintsQueryOptions(round))
    void queryClient.prefetchQuery(mbrQueryOptions(round))
    if (round !== undefined) void queryClient.prefetchQuery(roundTimestampQueryOptions(round))
  },
  loaderDeps: ({ search }) => ({ round: search.round }),
  loader: async ({ context: { queryClient }, deps }) => {
    const round = parseRound(deps.round)

    // What "now" is on the page: the round's block time when time travelling (one header read).
    // Only the first load waits for it. Moving to another round doesn't hold the app (the root
    // has no pending screen, so waiting here blanks everything): the time is set when it lands,
    // normally before the round's own data does.
    viewedRound = round
    const viewedTime =
      round === undefined
        ? Promise.resolve(undefined)
        : queryClient
            .ensureQueryData(roundTimestampQueryOptions(round))
            // Not the wall clock, which would show a validator that sunsetted after this round
            // as sunsetted at it: an estimate from the rounds whose times are known
            .catch(() => roundTimes.estimate(round))
    const settle = viewedTime.then((time) => {
      // A later round change wins over a read that lands after it
      if (viewedRound === round) setViewedTime(time)
    })
    if (firstLoad) {
      firstLoad = false
      await settle
    }
  },
  component: Root,
  notFoundComponent: () => {
    return <p>Not Found (on root route)</p>
  },
})

/**
 * Cancels the reads still loading for a round the app has moved away from that nothing shows: the
 * route prefetches, which React Query never cancels by itself (it cancels a query only when its
 * last observer goes). Stepping through rounds then doesn't finish a page of reads per round.
 */
function cancelUnseenReads(queryClient: QueryClient, round: bigint) {
  const key = roundKey(round)
  void queryClient.cancelQueries({
    fetchStatus: 'fetching',
    predicate: (query) =>
      query.queryKey[query.queryKey.length - 1] === key && query.getObserversCount() === 0,
  })
}

function Root() {
  useCheckForUpdates()

  return (
    <>
      <Layout>
        <Outlet />
      </Layout>
      {import.meta.env.DEV && (
        <>
          <ReactQueryDevtools buttonPosition="top-right" />
          <TanStackRouterDevtools position="bottom-right" />
        </>
      )}
    </>
  )
}
