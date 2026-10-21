import { cn } from '@/utils/ui'

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

export function Skeleton({ className, width, height, ...props }: SkeletonProps) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      style={{ width, height }}
      {...props}
    />
  )
}

interface SkeletonTextProps {
  /** Width of the bar: a Tailwind width class, e.g. `w-24` */
  className?: string
  /**
   * Text like the real value, for one that may wrap: drawn invisibly over bars, so it takes the
   * same lines as the value will at any width.
   */
  sample?: string
}

/**
 * Stands in for one line of text: exactly one line high in the surrounding font (`1lh`), so it
 * takes the room the text will, with a bar about the height of its letters.
 */
export function SkeletonText({ className, sample }: SkeletonTextProps) {
  if (sample !== undefined) {
    return (
      <span
        aria-hidden
        className={cn(
          'select-none animate-pulse rounded bg-muted text-transparent box-decoration-clone',
          className,
        )}
      >
        {sample}
      </span>
    )
  }
  return (
    <span aria-hidden className="flex h-[1lh] items-center">
      <span className={cn('block h-[0.8em] w-24 animate-pulse rounded bg-muted', className)} />
    </span>
  )
}
