import { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query'
import {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client'
import { isPinnedQueryKey } from '@/utils/round'

/**
 * Query key roots that survive a page reload.
 *
 * Deliberately an allowlist rather than "persist everything": account balances and staking
 * positions are volatile and wallet-scoped, and painting a stale one would be worse than a
 * spinner. What is here is either expensive (Nodely APY costs a request per pool), rate limited
 * and near-static (NFD), or the whole dashboard in one entry
 * (`all-validators`), which is what makes the first paint instant. Pools' version histories are
 * kept apart, in `algodHistoryStore`.
 */
const PERSISTED_QUERY_ROOTS = new Set([
  'all-validators',
  'pool-global-states',
  'validator-metrics',
  'nodely-apy',
  'realised-apy',
  'nfd',
  'nfd-lookup',
  'ipfs-url',
])

/** Bumped when a persisted entry changes shape within an app version (2: pool states as a plain object). */
const CACHE_SHAPE = 2

/** Nothing older than this is rehydrated, however long it sat in storage. */
const MAX_AGE = 1000 * 60 * 60 * 24 // 24 hours

/**
 * How long persisted queries stay resident, restored ones included. Must outlive `MAX_AGE`: an
 * entry that gets garbage collected is dropped from the next save, which would quietly evict it
 * from storage too.
 */
export const PERSISTED_GC_TIME = MAX_AGE

/**
 * Saves follow cache changes, and with metrics streaming in behind a 30 second `all-validators`
 * refetch (which seeds a few keys per validator) those are constant. Coalesce them: one
 * dehydrate and one write per window, not one per change.
 */
const SAVE_THROTTLE = 1000 * 5 // 5 seconds

/** Guards first paint against a wedged storage layer. */
const RESTORE_TIMEOUT = 1000 * 2 // 2 seconds

const DB_NAME = 'reti-query-cache'
const STORE_NAME = 'cache'
const ENTRY_KEY = 'client'

let dbPromise: Promise<IDBDatabase | null> | undefined

/**
 * Resolves `null` rather than rejecting when IndexedDB is missing or blocked (private
 * browsing, another tab holding an older version). Every caller then degrades to no
 * persistence instead of failing.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
  }
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await openDatabase()
  if (!db) {
    return undefined
  }
  return new Promise<T | undefined>((resolve) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const request = run(transaction.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
    transaction.onabort = () => resolve(undefined)
  })
}

function throttle<TArgs extends unknown[]>(fn: (...args: TArgs) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: TArgs

  return (...args: TArgs) => {
    latest = args
    if (timer) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      fn(...latest)
    }, wait)
  }
}

/**
 * IndexedDB stores values through the structured clone algorithm, which handles `bigint`
 * natively. That is the reason for using it over localStorage here: protocol data is full of
 * bigints (stake amounts, app ids, round numbers) and any JSON-backed persister would need a
 * hand-rolled codec, with silent corruption as the failure mode.
 *
 * Writes are not throttled here; {@link subscribeQueryCachePersistence} throttles whole saves.
 */
export function createQueryCachePersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      await withStore('readwrite', (store) => store.put(client, ENTRY_KEY))
    },

    restoreClient: () => withStore<PersistedClient>('readonly', (store) => store.get(ENTRY_KEY)),

    removeClient: async () => {
      await withStore('readwrite', (store) => store.delete(ENTRY_KEY))
    },
  }
}

export const persister = createQueryCachePersister()

/**
 * Whether a query's key is one that survives a reload. Reads pinned to a past round are cheap to
 * repeat and unbounded in number while scrubbing through history, so only the latest state is
 * kept.
 */
function isPersistedQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSISTED_QUERY_ROOTS.has(String(queryKey[0])) && !isPinnedQueryKey(queryKey)
}

/** Whether a query is written to storage on the next save. */
export function shouldPersistQuery(query: Query): boolean {
  return query.state.status === 'success' && isPersistedQueryKey(query.queryKey)
}

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: MAX_AGE,
  // A deploy can change the shape of what we cached; never hydrate across app versions, or across
  // a change of shape within one (bump CACHE_SHAPE)
  buster: `${__APP_VERSION__}:${CACHE_SHAPE}`,
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersistQuery,
  },
  hydrateOptions: {
    // Restored queries have no observer yet to set their gcTime, and the default 5 minutes
    // would drop anything not on the first page before its next save
    defaultOptions: { queries: { gcTime: PERSISTED_GC_TIME } },
  },
}

/** Cache changes that can change what a save writes: data in or out, not fetch status. */
const SAVED_ACTIONS = new Set(['success', 'error', 'setState'])

function changesSavedData(event: QueryCacheNotifyEvent): boolean {
  if (!isPersistedQueryKey(event.query.queryKey)) return false
  if (event.type === 'added' || event.type === 'removed') return true
  return event.type === 'updated' && SAVED_ACTIONS.has(event.action.type)
}

/**
 * Saves the cache whenever a persisted query's data changes, at most once per `wait`. Changes to
 * other queries (pinned reads, wallet data, fetch status) never trigger a save. Returns the
 * unsubscribe.
 *
 * @param wait - overridable so tests don't have to wait out the real interval
 */
export function subscribeQueryCachePersistence(
  queryClient: QueryClient,
  wait = SAVE_THROTTLE,
): () => void {
  const save = throttle(() => {
    void persistQueryClientSave({ queryClient, ...persistOptions })
  }, wait)
  return queryClient.getQueryCache().subscribe((event) => {
    if (changesSavedData(event)) save()
  })
}

/**
 * Hydrates the cache from disk, then keeps writing it back.
 *
 * Must complete before the router starts loading: the dashboard route prefetches
 * `all-validators` in `beforeLoad`, and a restore that lands after that request has already
 * gone out defeats the point of persisting it. Never rejects - the app renders off the back of
 * this, so a storage failure has to degrade to "no persistence", not "no app".
 */
export async function hydrateQueryCache(queryClient: QueryClient): Promise<void> {
  try {
    await Promise.race([
      persistQueryClientRestore({ queryClient, ...persistOptions }),
      new Promise((resolve) => setTimeout(resolve, RESTORE_TIMEOUT)),
    ])
    subscribeQueryCachePersistence(queryClient)
  } catch (error) {
    console.warn('Query cache persistence unavailable:', error)
  }
}
