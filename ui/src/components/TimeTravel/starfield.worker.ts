/**
 * Draws the warp's starfield on an offscreen canvas, off the main thread: a time jump keeps the
 * page busy re-rendering, and the stars shouldn't stutter with it.
 */
import { startStarfield, type StarfieldSize } from '@/components/TimeTravel/starfield'

export type StarfieldMessage =
  | ({ type: 'start'; canvas: OffscreenCanvas } & StarfieldSize)
  | ({ type: 'resize' } & StarfieldSize)
  | { type: 'stop' }

let starfield: ReturnType<typeof startStarfield> | undefined

self.onmessage = (event: MessageEvent<StarfieldMessage>) => {
  const message = event.data
  if (message.type === 'start') {
    starfield?.stop()
    starfield = startStarfield(message.canvas, message)
  } else if (message.type === 'resize') {
    starfield?.resize(message)
  } else {
    starfield?.stop()
    starfield = undefined
  }
}
