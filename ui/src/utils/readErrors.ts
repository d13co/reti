import { isHistoryUnavailable, isTimeLimitExceeded } from 'algosdk'
import { isRoundUnavailable } from '@/utils/round'

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

const FINAL_ERROR_NAMES = new Set(['DTUnsupportedError', 'DTNotAvailableError', 'AbortError'])

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

/**
 * The default query retry: three more tries, none for a round that can't be shown or a failure
 * another try can't change. utils has already retried transient HTTP failures by then, so only
 * network errors and transient 5xx (a node restarting) get more tries here.
 */
export function retryRead(failureCount: number, error: Error): boolean {
  return failureCount < 3 && !isRoundUnavailable(error) && !isFinalReadError(error)
}
