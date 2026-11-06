import {
  DEFAULT_RETRY_POLICY,
  isHistoryUnavailable,
  isNetworkError,
  isNodeBusy,
  isTimeLimitExceeded,
  retryAfterSeconds,
} from 'algosdk'
import { isAxiosError } from 'axios'
import { isRoundUnavailable, roundUnavailableMessage } from '@/utils/round'

/**
 * Read errors arrive wrapped: ghostkit wraps the HTTP error in a `GhostkitError` (`cause`), the
 * SDK wraps a refusal in a `DTUnsupportedError` (`cause`). The SDK's helpers only look at the error
 * they are given, so every check here runs over the whole chain.
 */
const MAX_CAUSE_DEPTH = 5

/** The error and its `cause` chain, at most {@link MAX_CAUSE_DEPTH} deep (a cycle stops there too). */
export function causes(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(current)) break
    chain.push(current)
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const e = error as { status?: unknown; response?: { status?: unknown } | null }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return undefined
}

/** The first HTTP status in the error's cause chain (algosdk sets `status`, axios `response.status`). */
export function httpStatusOf(error: unknown): number | undefined {
  for (const e of causes(error)) {
    const status = statusOf(e)
    if (status !== undefined) return status
  }
  return undefined
}

const FINAL_ERROR_NAMES = new Set([
  'DTUnsupportedError',
  'DTNotAvailableError',
  'AbortError',
  // `@/api/nfd` and `nfd-ghost-sdk`: no such NFD, or a node that can't read NFDs
  'NfdNotFoundError',
  'NfdUnavailableError',
  'NfdQueryUnavailableError',
])

function isFinalHere(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true
  }
  if (isHistoryUnavailable(error) || isTimeLimitExceeded(error)) return true
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' && FINAL_ERROR_NAMES.has(name)
}

/**
 * Whether a read failed in a way another try can't change: a client error (4xx, except 408 and
 * 429), history the node can't serve (503), the node's time limit (504), a node without the
 * feature, or a cancelled read. Network errors, a busy node and other 5xx are not final.
 */
export function isFinalReadError(error: unknown): boolean {
  return causes(error).some(isFinalHere)
}

/** The statuses the algod clients' own retry policy retries (dt-algosdk's default policy). */
const CLIENT_RETRY_STATUSES = new Set(DEFAULT_RETRY_POLICY.retryStatuses)

function retriedByClientHere(error: unknown): boolean {
  // The Nodely REST client retries by its own rules
  if (isAxiosError(error)) return false
  const status = statusOf(error)
  return status !== undefined ? CLIENT_RETRY_STATUSES.has(status) : isNetworkError(error)
}

/**
 * Whether a read failed in a way the algod client retries itself: a rate limit, a busy node, a
 * server error or a network error. dt-algosdk's retry policy has then already made up to five
 * tries over about 14 s (or given up at once on a `Retry-After` over 30 s).
 */
export function isRetriedByClient(error: unknown): boolean {
  return causes(error).some(retriedByClientHere)
}

/** Tries after the first for a read the algod client already retried: in case a node restarts. */
const CLIENT_RETRIED_QUERY_RETRIES = 1

/** Tries after the first for any other read that another try might fix. */
const QUERY_RETRIES = 3

/**
 * The default query retry. None for a round that can't be shown or a failure another try can't
 * change. One for a failure the algod client already retried: more would multiply its tries (up
 * to 20 requests for one read), and load a node that is already rate limiting or busy. Three for
 * anything else, such as a read the SDK couldn't finish.
 */
export function retryRead(failureCount: number, error: Error): boolean {
  if (isRoundUnavailable(error) || isFinalReadError(error)) return false
  return failureCount < (isRetriedByClient(error) ? CLIENT_RETRIED_QUERY_RETRIES : QUERY_RETRIES)
}

/** The least wait before a query the algod client already retried tries again. */
const CLIENT_RETRIED_DELAY_MS = 1000 * 10 // 10 seconds

/** The longest a query waits on a node's `Retry-After`. */
const MAX_RETRY_AFTER_MS = 1000 * 60 * 5 // 5 minutes

/**
 * The default query retry delay. A read the algod client already retried waits at least 10 s,
 * and as long as the node's `Retry-After` asks (the client gives up at once when that is over
 * 30 s). Anything else waits as react-query would: 1, 2, 4 s.
 */
export function retryReadDelay(failureCount: number, error: unknown): number {
  if (!isRetriedByClient(error)) return Math.min(1000 * 2 ** failureCount, 1000 * 30)
  const retryAfter = causes(error)
    .map(retryAfterSeconds)
    .find((seconds) => seconds !== undefined)
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(CLIENT_RETRIED_DELAY_MS, (retryAfter ?? 0) * 1000))
}

/** Why a read failed, in a sentence for the viewer, or undefined when it's nothing we can name. */
export function readFailureMessage(error: unknown): string | undefined {
  for (const e of causes(error)) {
    if (isRoundUnavailable(e)) return roundUnavailableMessage(e)
    if (isNodeBusy(e)) return 'The node is busy. Try again in a moment.'
    if (isHistoryUnavailable(e)) return "The node can't serve this history right now."
    if (isTimeLimitExceeded(e)) return 'This took longer than the node allows.'
    const name = (e as { name?: unknown } | null)?.name
    if (
      name === 'DTUnsupportedError' ||
      name === 'DTNotAvailableError' ||
      name === 'NfdUnavailableError'
    ) {
      return "The read node doesn't support this."
    }
  }
  return undefined
}

const MAX_NODE_MESSAGE_LENGTH = 200

function nodeMessageHere(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const response = (error as { response?: { text?: unknown; body?: unknown } | null }).response
  if (!response) return undefined
  let body: unknown = response.body
  if (typeof response.text === 'string') {
    try {
      body = JSON.parse(response.text)
    } catch {
      return undefined
    }
  }
  const message = (body as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined
}

/**
 * The node's own message for a failed read (its JSON error body's `message`, e.g. "the box index
 * is incomplete"), shortened to fit under a sentence, or undefined when the node sent none.
 */
export function nodeMessageOf(error: unknown): string | undefined {
  for (const e of causes(error)) {
    const message = nodeMessageHere(e)
    if (message !== undefined) {
      return message.length > MAX_NODE_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_NODE_MESSAGE_LENGTH - 1)}…`
        : message
    }
  }
  return undefined
}
