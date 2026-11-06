import { Query, QueryClient, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

/**
 * Key roots that hold nothing up: the extras themselves (Nodely, realised APY), and NFD names,
 * which the page shows addresses in place of until they load (each round's are one batched read
 * on the read node). Everything else, the page's own reads and its history charts, loads before
 * the extras.
 */
export const LATE_QUERY_ROOTS = new Set([
  'nodely-apy',
  'nodely-perf',
  'realised-apy',
  'nfd',
  'nfd-lookup',
])

const holdsExtrasUp = (query: Query) => !LATE_QUERY_ROOTS.has(String(query.queryKey[0]))

/** How long the reads before the extras must be quiet before they start. */
const QUIET_MS = 500

/** Start the extras anyway after this long, so a stuck or slow read doesn't hold them forever. */
const MAX_WAIT_MS = 20_000

/** Whether the extras have started. */
let ready = false

const listeners = new Set<() => void>()

/** The client being watched, to restart the watch on {@link resetExtrasReady}. */
let watchedClient: QueryClient | undefined

/** Stops watching the query cache; set while watching. */
let stopWatching: (() => void) | undefined

function notify() {
  listeners.forEach((listener) => listener())
}

/**
 * Watches the query cache until the extras may start, then stops: after that nothing here runs
 * on cache events, and no component re-renders for them.
 */
function watch(queryClient: QueryClient) {
  watchedClient = queryClient
  if (ready || stopWatching) return
  const cache = queryClient.getQueryCache()
  let quietTimer: ReturnType<typeof setTimeout> | undefined

  const start = () => {
    ready = true
    stopWatching?.()
    notify()
  }

  // Quiet: restarts whenever a read the extras wait for starts fetching
  const check = () => {
    const busy = cache.findAll({ fetchStatus: 'fetching', predicate: holdsExtrasUp }).length > 0
    if (busy) {
      clearTimeout(quietTimer)
      quietTimer = undefined
    } else if (!quietTimer) {
      quietTimer = setTimeout(start, QUIET_MS)
    }
  }
  // Cache events come in floods (a round's data seeded, a page of reads mounting: thousands at
  // once), and each check scans the whole cache. So one check once a flood has passed, and only
  // for the events that change what is fetching: a query's own updates and its removal.
  let checkTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = cache.subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return
    if (checkTimer !== undefined) return
    checkTimer = setTimeout(() => {
      checkTimer = undefined
      check()
    }, 0)
  })
  // The ceiling: counted from when the first component asked, whatever is fetching
  const maxTimer = setTimeout(start, MAX_WAIT_MS)

  stopWatching = () => {
    unsubscribe()
    clearTimeout(checkTimer)
    clearTimeout(quietTimer)
    clearTimeout(maxTimer)
    stopWatching = undefined
  }
  check()
}

/**
 * Whether the page's extras (Nodely, realised APY, gating assets) may load: everything else on
 * the page, its own reads and its history charts, has been quiet for {@link QUIET_MS}, or
 * {@link MAX_WAIT_MS} has passed. It stays true across routes, so later polling doesn't hold the
 * extras back again; moving to another round starts over ({@link resetExtrasReady}).
 */
export function useExtrasReady(): boolean {
  const queryClient = useQueryClient()
  const subscribe = React.useCallback(
    (listener: () => void) => {
      listeners.add(listener)
      watch(queryClient)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopWatching?.()
      }
    },
    [queryClient],
  )
  return React.useSyncExternalStore(subscribe, () => ready)
}

/**
 * Holds the extras back again, for a new round: its own reads and charts go first. What's on
 * screen stays (the extras keep their previous data while they wait).
 */
export function resetExtrasReady(): void {
  if (!ready) return
  ready = false
  if (listeners.size > 0 && watchedClient) watch(watchedClient)
  notify()
}
