/**
 * The least time between two runs of query notifications. After the first paint the dashboard's
 * names, metrics and APYs land a few at a time, roughly every 50 ms; each landing was a render of
 * the page. Spaced out, they make at most one render per window. An update that arrives when
 * nothing has run for a window is not held back.
 */
export const COALESCE_WINDOW_MS = 100

/**
 * A scheduler for TanStack Query's `notifyManager.setScheduler`. The default runs each flush in
 * its own `setTimeout(0)`, so updates that land a few milliseconds apart each render separately.
 * This one runs the first flush as soon as the default would, then holds what follows until the
 * window since that run has passed, and runs it all in one task, where React batches the state
 * updates into one render.
 */
export function createCoalescingScheduler(
  windowMs = COALESCE_WINDOW_MS,
): (callback: () => void) => void {
  let pending: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRun = -Infinity

  const run = () => {
    timer = undefined
    lastRun = Date.now()
    const callbacks = pending
    pending = []
    // One failing callback must not cost the others their update
    let failure: { error: unknown } | undefined
    for (const callback of callbacks) {
      try {
        callback()
      } catch (error) {
        failure ??= { error }
      }
    }
    if (failure) throw failure.error
  }

  return (callback) => {
    pending.push(callback)
    if (timer === undefined) {
      timer = setTimeout(run, Math.max(0, lastRun + windowMs - Date.now()))
    }
  }
}
