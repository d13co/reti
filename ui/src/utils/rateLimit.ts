import { isHistoryUnavailable, type RetryWait } from 'algosdk'
import { causes, httpStatusOf } from '@/utils/readErrors'

/**
 * Upstreams the dashboard fans out to. Limits are learned per host, as separate services have
 * separate budgets. Only algod for now: NFDs are read through it (`nfd-ghost-sdk`).
 *
 * Nodely is not listed: the only queue that touches it is validator metrics, and
 * `fetchNodelyVotingPerf` swallows its failures, so no Nodely rate limiting ever reaches a
 * query result to learn from.
 */
export type RateLimitedHost = 'algod'

interface HostLimits {
  /** Floor. Must be >= 1 so the queue can never converge to a stall. */
  min: number
  max: number
  /** Used on a cold start, and as the clamp target for anything read back from storage. */
  initial: number
}

/**
 * Ranges are per batch tick (one second). `algod` is shared by the metrics and asset queues,
 * whose batches cost very different numbers of requests, so its ceiling is set for the
 * expensive one (metrics: up to a few dozen requests per validator).
 */
const HOST_LIMITS: Record<RateLimitedHost, HostLimits> = {
  algod: { min: 2, max: 8, initial: 4 },
}

/** Clean batch ticks required before probing one step higher. */
const CLEAN_TICKS_PER_INCREASE = 2

const STORAGE_PREFIX = 'reti-batch-size:'

const RATE_LIMIT_STATUSES = new Set([429, 503])

/**
 * Rate limiting reaches us in three shapes: an algosdk client error carrying a bare `status`,
 * an `AxiosError` (Nodely), and - when a fetch layer flattens it - a message string.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  // Through the whole cause chain: ghostkit and the SDKs wrap the HTTP error
  const chain = causes(error)
  // A 503 for history the node can't serve is not load: don't shrink the batch for it
  if (chain.some(isHistoryUnavailable)) {
    return false
  }

  const status = httpStatusOf(error)
  if (status !== undefined && RATE_LIMIT_STATUSES.has(status)) {
    return true
  }

  return chain.some((e) => {
    const message = (e as { message?: unknown } | null)?.message
    return typeof message === 'string' && /\b(429|503|too many requests)\b/i.test(message)
  })
}

/** The least time between two backoffs learned from a read client's own retries. */
const RETRY_WAIT_BACKOFF_INTERVAL_MS = 1000

let lastRetryWaitBackoff = 0

/**
 * Backs the algod queues off when the read node makes a request wait to retry it, rate limited
 * or busy: the read client's retry policy calls this before each retry (`onWait`), so the queues
 * learn of it at once rather than only after the request's retries have run out. At most once a
 * second, as a queue learns at most once per batch tick.
 */
export function noteAlgodRetryWait(wait: Pick<RetryWait, 'reason'>): void {
  if (wait.reason !== 'rate-limited' && wait.reason !== 'node-busy') {
    return
  }
  const now = Date.now()
  if (now - lastRetryWaitBackoff < RETRY_WAIT_BACKOFF_INTERVAL_MS) {
    return
  }
  lastRetryWaitBackoff = now
  getBatchSizeController('algod').recordThrottled()
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage is a nicety here; a fresh probe every load is an acceptable fallback
  }
}

/**
 * AIMD controller over a queue's batch size: additive increase while batches land cleanly,
 * multiplicative decrease the moment one is rate limited.
 *
 * The learned value is persisted so the next page load starts near the rate this client
 * already knows the host will take, rather than rediscovering it from scratch. It is only a
 * starting point - additive increase re-probes upward every load, so a value learned during a
 * bad minute can't pin the client low forever.
 */
export class AdaptiveBatchSize {
  private readonly limits: HostLimits
  private readonly storageKey: string
  private cleanTicks = 0
  private value: number

  constructor(private readonly host: RateLimitedHost) {
    this.limits = HOST_LIMITS[host]
    this.storageKey = `${STORAGE_PREFIX}${host}`
    this.value = this.restore()
  }

  get current(): number {
    return this.value
  }

  /** A batch tick completed with no new rate limiting. */
  recordClean(): void {
    this.cleanTicks += 1
    if (this.cleanTicks < CLEAN_TICKS_PER_INCREASE) {
      return
    }
    this.cleanTicks = 0
    this.set(this.value + 1, 'increase')
  }

  /** A query in the last batch came back rate limited. */
  recordThrottled(): void {
    this.cleanTicks = 0
    this.set(Math.floor(this.value / 2), 'backoff')
  }

  private restore(): number {
    const stored = Number(readStorage(this.storageKey))
    return Number.isFinite(stored) && stored > 0 ? this.clamp(stored) : this.limits.initial
  }

  private clamp(value: number): number {
    return Math.min(this.limits.max, Math.max(this.limits.min, Math.round(value)))
  }

  private set(next: number, reason: 'increase' | 'backoff'): void {
    const clamped = this.clamp(next)
    if (clamped === this.value) {
      return
    }
    this.value = clamped
    writeStorage(this.storageKey, String(clamped))
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug(`[rate-limit] ${this.host} batch size ${reason} -> ${clamped}`)
    }
  }
}

const controllers = new Map<RateLimitedHost, AdaptiveBatchSize>()

/** Controllers are per host and shared across call sites, so backoff applies to the service. */
export function getBatchSizeController(host: RateLimitedHost): AdaptiveBatchSize {
  let controller = controllers.get(host)
  if (!controller) {
    controller = new AdaptiveBatchSize(host)
    controllers.set(host, controller)
  }
  return controller
}
