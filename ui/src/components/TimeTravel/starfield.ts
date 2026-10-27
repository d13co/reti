/**
 * The warp's starfield: stars streaking out from the middle, speeding up into a warp. Draws on a
 * page canvas or, from a worker, an offscreen one, so it keeps moving while the page is busy.
 */

export interface StarfieldSize {
  width: number
  height: number
  /** Device pixels per CSS pixel, already capped */
  dpr: number
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Depth a second at the top speed, reached after about 1.2s */
const MAX_SPEED = 6

/** Starts drawing on `canvas`; returns how to resize and stop it. */
export function startStarfield(canvas: HTMLCanvasElement | OffscreenCanvas, size: StarfieldSize) {
  const context = canvas.getContext('2d') as Context | null
  if (!context) return { resize: () => {}, stop: () => {} }

  let { width, height } = size
  const resize = (next: StarfieldSize) => {
    ;({ width, height } = next)
    canvas.width = Math.round(width * next.dpr)
    canvas.height = Math.round(height * next.dpr)
    context.setTransform(next.dpr, 0, 0, next.dpr, 0, 0)
  }
  resize(size)

  // Stars in a box in front of the viewer: x and y in -1..1, depth in 0..1
  const count = Math.round(Math.min(Math.max((width * height) / 5000, 120), 360))
  const xs = new Float32Array(count)
  const ys = new Float32Array(count)
  const zs = new Float32Array(count)
  const respawn = (i: number, z: number) => {
    xs[i] = Math.random() * 2 - 1
    ys[i] = Math.random() * 2 - 1
    zs[i] = z
  }
  for (let i = 0; i < count; i++) respawn(i, Math.random())
  // Each frame's streaks, [x0, y0, x1, y1] per star, and whether it's near (bright)
  const lines = new Float32Array(count * 4)
  const near = new Uint8Array(count)

  const strokeStreaks = (bright: number) => {
    context.beginPath()
    for (let i = 0; i < count; i++) {
      if (near[i] !== bright) continue
      context.moveTo(lines[i * 4], lines[i * 4 + 1])
      context.lineTo(lines[i * 4 + 2], lines[i * 4 + 3])
    }
    context.stroke()
  }

  const schedule: (draw: (now: number) => void) => number =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (draw) => setTimeout(() => draw(performance.now()), 16) as unknown as number
  const cancel: (frame: number) => void =
    typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout

  let frame = 0
  let start = 0
  let last = 0
  const draw = (now: number) => {
    if (!start) start = last = now
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    // Eases in: from a drift, accelerating the whole way through a jump (a second or so), only
    // levelling off for a slow one so the stars don't strobe
    const t = (now - start) / 1000
    const speed = Math.min(0.2 + 4 * t * t, MAX_SPEED)
    // A streak is where the star was a moment ago: longer as it speeds up
    const trail = 0.004 + 0.014 * speed

    const cx = width / 2
    const cy = height / 2
    // Small enough that far stars start near the middle and streak out as they near
    const focal = Math.max(width, height) * 0.15

    for (let i = 0; i < count; i++) {
      let z = zs[i] - speed * dt
      if (z <= 0.01) {
        respawn(i, 1)
        z = 1
      }
      zs[i] = z
      const x = cx + (xs[i] / z) * focal
      const y = cy + (ys[i] / z) * focal
      if (x < 0 || x > width || y < 0 || y > height) {
        respawn(i, 1)
        near[i] = 2 // not drawn this frame
        continue
      }
      const tz = z + trail
      lines[i * 4] = cx + (xs[i] / tz) * focal
      lines[i * 4 + 1] = cy + (ys[i] / tz) * focal
      lines[i * 4 + 2] = x
      lines[i * 4 + 3] = y
      near[i] = z > 0.45 ? 0 : 1
    }

    context.clearRect(0, 0, width, height)
    context.lineCap = 'round'
    // Far stars dim and thin, near ones bright
    context.strokeStyle = 'rgba(200, 215, 255, 0.45)'
    context.lineWidth = 1
    strokeStreaks(0)
    context.strokeStyle = 'rgba(235, 240, 255, 0.95)'
    context.lineWidth = 1.75
    strokeStreaks(1)

    frame = schedule(draw)
  }
  frame = schedule(draw)

  return { resize, stop: () => cancel(frame) }
}
