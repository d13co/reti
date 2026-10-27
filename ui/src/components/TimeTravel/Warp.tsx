import * as React from 'react'
import { createPortal } from 'react-dom'
import { startStarfield, type StarfieldSize } from '@/components/TimeTravel/starfield'
import type { StarfieldMessage } from '@/components/TimeTravel/starfield.worker'

/** How long the stars take to appear and everything to fade out, in ms */
const FADE_IN_MS = 120
const FADE_OUT_MS = 300
/** How long the backdrop takes to darken, easing in */
const BACKDROP_IN_MS = 500

interface WarpProps {
  /** Shown while true; fades out when it turns false */
  active: boolean
  /** What it's travelling to, in the middle of the screen */
  label?: string
}

export interface WarpHandle {
  /**
   * Fades out at `time` (a `performance.now()` time) on the compositor, on time even if the page
   * is busy then rendering where it jumped to. `active` turning false still ends it sooner.
   */
  fadeOutAt: (time: number) => void
}

/**
 * A starfield warp over the whole page while time travel jumps, on a semi-transparent backdrop
 * that eases in. Drawn only while shown, on one canvas (two strokes a frame, at most 1.5x device
 * pixels, off the main thread where the browser can). With reduced motion, just the fade and
 * the label.
 *
 * The fades in are keyframe animations (`warp-fade-in` in main.css), which run as the overlay is
 * inserted; the fade out is a transition once it's no longer active, or one scheduled ahead with
 * `fadeOutAt`.
 */
export const Warp = React.forwardRef<WarpHandle, WarpProps>(function Warp({ active, label }, ref) {
  const [mounted, setMounted] = React.useState(active)
  const reduceMotion = usePrefersReducedMotion()
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const scheduledRef = React.useRef<Animation>()

  React.useImperativeHandle(ref, () => ({
    fadeOutAt: (time) => {
      scheduledRef.current?.cancel()
      scheduledRef.current = overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
        delay: Math.max(time - performance.now(), 0),
        duration: FADE_OUT_MS,
        easing: 'ease-out',
        fill: 'forwards',
      })
    },
  }))

  // Ending sooner: a scheduled fade that hasn't started yet would undo the one starting now
  React.useEffect(() => {
    const scheduled = scheduledRef.current
    if (!active && scheduled && scheduled.effect?.getComputedTiming().progress === null) {
      scheduled.cancel()
    }
  }, [active])

  React.useEffect(() => {
    if (active) {
      setMounted(true)
      return
    }
    // Normally gone when its fade out ends (below); this is in case that never fires
    const timer = setTimeout(() => setMounted(false), FADE_OUT_MS + 1000)
    return () => clearTimeout(timer)
  }, [active])

  if (!mounted && !active) return null
  const leaving = !active

  return createPortal(
    <div
      ref={overlayRef}
      // Its own layer, cut off from the page's layout and paint, so fading it costs the page nothing
      className="pointer-events-none fixed inset-0 z-[100] [contain:strict] [will-change:opacity]"
      style={{
        animation: `warp-fade-in ${FADE_IN_MS}ms linear backwards`,
        opacity: leaving ? 0 : 1,
        transition: leaving ? `opacity ${FADE_OUT_MS}ms ease-out` : undefined,
      }}
      // Removed once the fade out has played, not after a fixed time: the page can hold the main
      // thread just as it ends, which would otherwise cut the fade short
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === 'opacity') {
          setMounted(false)
        }
      }}
      data-test-id="time-travel-warp"
    >
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(11_16_38/0.55)_0%,rgb(0_0_0/0.7)_75%)] [will-change:opacity]"
        style={{ animation: `warp-fade-in ${BACKDROP_IN_MS}ms ease-in backwards` }}
        aria-hidden
      />
      {!reduceMotion && <Starfield />}
      {label && (
        <div className="absolute inset-0 grid place-items-center" role="status">
          <p className="rounded-full bg-black/60 px-4 py-1.5 text-sm font-medium tracking-wide text-white/90">
            {label}
          </p>
        </div>
      )}
    </div>,
    document.body,
  )
})

/**
 * The stars, drawn by a worker on an offscreen canvas where the browser can, else on the page.
 * The canvas is made here rather than rendered: one can be handed to a worker only once, and
 * React may run this effect twice.
 */
function Starfield() {
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const canvas = document.createElement('canvas')
    canvas.className = 'absolute inset-0 h-full w-full'
    container.appendChild(canvas)

    const size = (): StarfieldSize => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    })

    let resize: (next: StarfieldSize) => void
    let stop: () => void
    const worker = startWorker(canvas, size())
    if (worker) {
      resize = (next) => worker.postMessage({ type: 'resize', ...next } satisfies StarfieldMessage)
      stop = () => worker.terminate()
    } else {
      ;({ resize, stop } = startStarfield(canvas, size()))
    }

    const onResize = () => resize(size())
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      stop()
      canvas.remove()
    }
  }, [])

  return <div ref={containerRef} className="absolute inset-0" aria-hidden />
}

/** A worker drawing on `canvas`, or undefined where offscreen canvases aren't supported. */
function startWorker(canvas: HTMLCanvasElement, size: StarfieldSize): Worker | undefined {
  if (typeof Worker === 'undefined' || !('transferControlToOffscreen' in canvas)) return undefined
  try {
    const offscreen = canvas.transferControlToOffscreen()
    const worker = new Worker(new URL('./starfield.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.postMessage({ type: 'start', canvas: offscreen, ...size } satisfies StarfieldMessage, [
      offscreen,
    ])
    return worker
  } catch {
    return undefined
  }
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  return React.useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
