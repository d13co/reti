/**
 * Console tracing for the history reads: one line per request, with what it's for, its
 * parameters, how long it took and what came back, e.g.
 *
 *   [reti] totals-series registry 3m · time>round, target=2026-07-21T10:04:12Z, pass=1, sim=1, estimate=57982211, rounds=16 (57978211…57986211), rt=53ms → bracket=57981677…57982211
 *
 * On in development. Elsewhere, run `localStorage.setItem('reti:trace', '1')` and reload.
 */
const enabled = (() => {
  if (import.meta.env.DEV) return true
  try {
    return localStorage.getItem('reti:trace') === '1'
  } catch {
    return false
  }
})()

type Params = Record<string, unknown>

/** A block time (seconds) or date as ISO 8601, to the second. */
export const isoTime = (time: Date | number): string =>
  (typeof time === 'number' ? new Date(time * 1000) : time).toISOString().replace(/\.\d{3}Z$/, 'Z')

const formatParams = (params: Params): string =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) => `, ${key}=${value instanceof Date ? isoTime(value) : String(value)}`)
    .join('')

// The point of this module is to write to the console
// eslint-disable-next-line no-console
const log = (line: string) => console.log(line)

const elapsed = (since: number) => `${Math.round(performance.now() - since)}ms`

/** Whether an error is an abort: the read was cancelled, not failed. */
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

export interface Trace {
  /** Cancels the query's reads; each step checks it before it starts. */
  readonly signal?: AbortSignal
  /**
   * Runs one request and logs it once it settles. A `cached` param or the `summary` option keeps
   * it out of the request count. Throws the signal's abort reason, without running the request,
   * once the query has been cancelled.
   */
  step<T>(
    purpose: string,
    params: Params,
    request: () => Promise<T>,
    describe?: (value: T) => string,
    options?: { summary?: boolean },
  ): Promise<T>
  /** Logs the query's total once it's done. */
  done(summary?: string): void
}

/**
 * A trace for one query run; `name` prefixes its lines so concurrent queries stay apart. With a
 * `signal`, every step checks it first, so a cancelled query stops between requests.
 */
export function traceQuery(name: string, signal?: AbortSignal): Trace {
  const started = performance.now()
  let requests = 0
  const prefix = `[reti] ${name} ·`

  return {
    signal,
    async step(purpose, params, request, describe, options) {
      signal?.throwIfAborted()
      if (!enabled) return request()
      if (!params.cached && !options?.summary) requests += 1
      const since = performance.now()
      try {
        const value = await request()
        const result = describe ? ` → ${describe(value)}` : ''
        log(`${prefix} ${purpose}${formatParams({ ...params, rt: elapsed(since) })}${result}`)
        return value
      } catch (error) {
        if (isAbortError(error)) {
          log(`${prefix} ${purpose}${formatParams({ ...params, rt: elapsed(since) })} · cancelled`)
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `${prefix} ${purpose}${formatParams({ ...params, rt: elapsed(since) })} ✗ ${message}`,
        )
        throw error
      }
    },
    done(summary) {
      if (!enabled) return
      log(
        `${prefix} done${summary ? `, ${summary}` : ''}, requests=${requests}, rt=${elapsed(started)}, page=+${(started / 1000).toFixed(2)}s→+${(performance.now() / 1000).toFixed(2)}s`,
      )
    },
  }
}
