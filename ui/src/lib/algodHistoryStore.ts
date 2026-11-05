import type { AlgodVerChange } from '@/utils/upgrades'

/**
 * Pools' `algodVer` histories, kept in IndexedDB apart from the query cache.
 *
 * A pool's past versions never change, so its history is worth keeping across deploys and well
 * past the query cache's 24 hours. Read in full, it takes ~300 requests; kept, a visit only lists
 * what's new since. The query cache can't hold it that way: it busts on every app version and
 * rewrites the whole cache on each save, which here would mean cloning a pool's tens of thousands
 * of changes every few seconds while a scan runs.
 *
 * So each pool is its own record, written when its history gained changes or, at most daily, to
 * move its `to` on (never for every scan that found nothing new), and writes are batched into one
 * transaction when the page is idle.
 */

/** A pool's history as stored. */
export interface StoredAlgodHistory {
  /** The last round listed, inclusive */
  to: bigint
  /** Every change up to `to`, oldest first */
  changes: AlgodVerChange[]
  /** When it was listed up to `to`, in ms */
  savedAt: number
}

interface StoredRecord extends StoredAlgodHistory {
  shape: number
}

/** Bumped when a record changes shape; records of another shape are ignored. */
const SHAPE = 1

/**
 * Records not written for this long are dropped on restore. A pool that's viewed is rewritten at
 * least every {@link REWRITE_AGE}, so this clears out pools nobody looks at any more.
 */
const MAX_AGE = 1000 * 60 * 60 * 24 * 30 // 30 days

/**
 * How old a kept record gets before a listing that found nothing new rewrites it anyway: often
 * enough to keep it from expiring and to keep later listings short, rarely enough not to rewrite
 * every pool on every visit.
 */
const REWRITE_AGE = 1000 * 60 * 60 * 24 // 1 day

/** How long writes wait to be batched together. */
const WRITE_DELAY = 1000 * 5 // 5 seconds

const DB_NAME = 'reti-algod-history'
const STORE_NAME = 'pools'

let dbPromise: Promise<IDBDatabase | null> | undefined

/** Resolves `null` when IndexedDB is missing or blocked: then nothing is kept. */
function openDatabase(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      try {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

/** Records are keyed by registry and pool, so networks and registries never mix. */
const recordKey = (registryAppId: bigint, poolAppId: bigint) => `${registryAppId}:${poolAppId}`

/** What's in storage for each record this page has read or written, to tell what's worth a write. */
const kept = new Map<string, { changes: number; savedAt: number }>()

/**
 * Every kept history of the registry's pools, by pool app id. Expired and stale-shaped records
 * are left out (and deleted). Empty if storage is unavailable.
 */
export async function restoreAlgodHistories(
  registryAppId: bigint,
): Promise<Map<bigint, StoredAlgodHistory>> {
  const histories = new Map<bigint, StoredAlgodHistory>()
  const db = await openDatabase()
  if (!db) return histories
  const prefix = `${registryAppId}:`
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
  const now = Date.now()
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.openCursor(range)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const record = cursor.value as StoredRecord
        if (record?.shape !== SHAPE || now - record.savedAt > MAX_AGE) {
          cursor.delete()
        } else {
          const poolAppId = BigInt(String(cursor.key).slice(prefix.length))
          if (!kept.has(String(cursor.key))) {
            kept.set(String(cursor.key), {
              changes: record.changes.length,
              savedAt: record.savedAt,
            })
          }
          histories.set(poolAppId, {
            to: record.to,
            changes: record.changes,
            savedAt: record.savedAt,
          })
        }
        cursor.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
  return histories
}

/** Histories waiting to be written, by record key; a newer one replaces an older. */
const pending = new Map<string, StoredRecord>()
let scheduled = false

/** Runs `fn` when the page is idle, or soon where it can't say. */
function whenIdle(fn: () => void) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: WRITE_DELAY })
  } else {
    setTimeout(fn, 0)
  }
}

async function flush() {
  scheduled = false
  if (pending.size === 0) return
  const records = [...pending]
  pending.clear()
  const db = await openDatabase()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      for (const [key, record] of records) store.put(record, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      // Storage full or gone: the histories are read again next time
      resolve()
    }
  })
}

let flushesWhenHidden = false

/** Writes what's pending when the tab is hidden, as it may be closed before the delay is up. */
function flushWhenHidden() {
  if (flushesWhenHidden || typeof document === 'undefined') return
  flushesWhenHidden = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })
}

/**
 * Keeps a pool's history as listed up to `history.to`, if it's worth a write: one not kept yet,
 * one that gained changes, or one whose record is a day old. Changes are only ever appended, so a
 * history with as many changes as its record holds the same ones.
 */
export function saveAlgodHistory(
  registryAppId: bigint,
  poolAppId: bigint,
  history: { to: bigint; changes: AlgodVerChange[] },
) {
  const key = recordKey(registryAppId, poolAppId)
  const now = Date.now()
  const previous = kept.get(key)
  if (
    previous &&
    previous.changes === history.changes.length &&
    now - previous.savedAt < REWRITE_AGE
  ) {
    return
  }
  kept.set(key, { changes: history.changes.length, savedAt: now })
  pending.set(key, { shape: SHAPE, to: history.to, changes: history.changes, savedAt: now })
  flushWhenHidden()
  if (scheduled) return
  scheduled = true
  setTimeout(() => whenIdle(() => void flush()), WRITE_DELAY)
}

/** Writes what's pending now, for tests. */
export function flushAlgodHistories(): Promise<void> {
  return flush()
}
