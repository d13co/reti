import { nodeMessageOf, readFailureMessage } from '@/utils/readErrors'
import { cn } from '@/utils/ui'

interface ReadFailureProps {
  /** What failed, e.g. "Couldn't load changes" */
  title: string
  error: unknown
  className?: string
}

/**
 * A failed read: what failed and, when it can be named, why (the node is busy, history it can't
 * serve, its time limit, a feature it lacks), with the node's own message on a smaller line below.
 */
export function ReadFailure({ title, error, className }: ReadFailureProps) {
  const reason = readFailureMessage(error)
  const detail = nodeMessageOf(error)
  return (
    <div className={cn('text-sm text-destructive', className)}>
      <p>{reason ? `${title}. ${reason}` : title}</p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}
