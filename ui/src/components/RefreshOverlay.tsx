import { Loading } from '@/components/Loading'
import { cn } from '@/utils/ui'

interface RefreshOverlayProps {
  /** Whether the content under it is stale: on screen while its replacement loads */
  active: boolean
  /**
   * For sections taller than the screen: the spinner stays in view while scrolling, instead of
   * sitting in the middle of the section.
   */
  tall?: boolean
  className?: string
}

/**
 * Dims a section and spins over it while it loads (another round, say), leaving what it shows in
 * place so nothing moves. Put it last inside a `relative` container, and set `aria-busy` there.
 * It fades in after a moment, so a quick load doesn't flash it.
 */
export function RefreshOverlay({ active, tall = false, className }: RefreshOverlayProps) {
  if (!active) {
    return null
  }
  return (
    <div
      aria-hidden
      data-refreshing
      className={cn(
        'absolute inset-0 z-10 flex justify-center rounded-[inherit] bg-background/60',
        'animate-in fade-in-0 fill-mode-both duration-300 delay-150',
        tall ? 'items-start pt-24' : 'items-center',
        className,
      )}
    >
      <div className={cn('rounded-full bg-background/80 p-2 shadow-sm', tall && 'sticky top-1/2')}>
        <Loading size="md" inline />
      </div>
    </div>
  )
}
