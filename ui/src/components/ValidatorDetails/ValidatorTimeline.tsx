import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { changeRoundsInfiniteQueryOptions, TimelineTarget } from '@/api/history'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { RefreshOverlay } from '@/components/RefreshOverlay'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SkeletonText } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAtRound } from '@/hooks/useAtRound'
import { useSetRound } from '@/hooks/useSetRound'
import { Validator } from '@/interfaces/validator'
import { dayjs } from '@/utils/dayjs'
import { getPoolNameFromIndex } from '@/utils/pools'
import { keepAcrossRounds } from '@/utils/round'
import { cn } from '@/utils/ui'

interface ValidatorTimelineProps {
  validator: Validator
}

/**
 * The rounds at which this validator (or one of its pools) changed, up to the round on screen.
 * Each one opens the whole app at that round.
 */
export function ValidatorTimeline({ validator }: ValidatorTimelineProps) {
  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  const { round } = useAtRound()
  const setRound = useSetRound()

  // 'validator', 'pool:<index>' or 'stakers:<index>'
  const [selected, setSelected] = React.useState('validator')

  const target = React.useMemo((): TimelineTarget => {
    const [kind, index] = selected.split(':')
    const pool = validator.pools[Number(index)]
    if (kind === 'pool' && pool) return { pool: pool.poolAppId }
    if (kind === 'stakers' && pool) return { poolStakers: pool.poolAppId }
    return { validator: validator.id }
  }, [selected, validator.id, validator.pools])

  // Moving to another round keeps the list on screen until the new one loads
  const changesQuery = useInfiniteQuery(
    keepAcrossRounds({
      ...changeRoundsInfiniteQueryOptions(target, round),
      enabled: !!supportQuery.data?.supported,
    }),
  )

  if (!supportQuery.data?.supported) {
    // Room for the card until the node says whether it can serve past rounds
    return supportQuery.isPending ? <ValidatorTimelineSkeleton /> : null
  }

  const changes = changesQuery.data?.pages.flatMap((page) => page.changes) ?? []
  // The change that produced what's on screen: the newest one at or before the round
  const shownChange = round === undefined ? undefined : changes[0]?.round

  return (
    <Card className="relative" aria-busy={changesQuery.isPlaceholderData}>
      <CardHeader>
        <div className="flex items-center justify-between gap-x-2">
          <CardTitle>Changes</CardTitle>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="-my-2.5 w-[170px]" aria-label="What to list the changes of">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="validator">Validator record</SelectItem>
              {validator.pools.map((_, index) => (
                <React.Fragment key={index}>
                  <SelectItem value={`pool:${index}`}>
                    {getPoolNameFromIndex(index)} state
                  </SelectItem>
                  <SelectItem value={`stakers:${index}`}>
                    {getPoolNameFromIndex(index)} stakers
                  </SelectItem>
                </React.Fragment>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TimelineNote pinned={round !== undefined} />
      </CardHeader>
      <CardContent>
        {changesQuery.isPending ? (
          <TimelineRowsSkeleton />
        ) : changesQuery.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load changes</p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        ) : (
          <ScrollArea className="h-80 pr-3">
            <ol className="space-y-0.5" data-test-id="validator-timeline">
              {changes.map((change) => (
                <li key={change.round.toString()}>
                  <button
                    type="button"
                    onClick={() => setRound(change.round)}
                    className={cn(
                      'flex w-full items-center justify-between gap-x-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                      change.round === shownChange && 'bg-muted font-medium',
                    )}
                  >
                    <span>{dayjs.unix(change.timestamp).format('lll')}</span>
                    <span className="flex items-center gap-x-2">
                      {change.deleted && <Badge variant="secondary">deleted</Badge>}
                      <span className="font-mono text-xs text-muted-foreground">
                        {change.round.toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {changesQuery.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                disabled={changesQuery.isFetchingNextPage}
                onClick={() => changesQuery.fetchNextPage()}
              >
                {changesQuery.isFetchingNextPage ? 'Loading…' : 'Older changes'}
              </Button>
            )}
          </ScrollArea>
        )}
      </CardContent>
      <RefreshOverlay active={changesQuery.isPlaceholderData} />
    </Card>
  )
}

function TimelineNote({ pinned }: { pinned: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      Rounds where it changed{pinned ? ' up to the round shown' : ''}, newest first. Pick one to see
      Réti as it was then.
    </p>
  )
}

/** As many rows as fill the list's height. */
const SKELETON_ROWS = 10

function TimelineRowsSkeleton() {
  return (
    <ol className="h-80 space-y-0.5 overflow-hidden pr-3" aria-busy>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <li
          key={i}
          className="flex w-full items-center justify-between gap-x-3 px-2 py-1.5 text-sm"
        >
          <SkeletonText className="w-36" />
          <span className="text-xs">
            <SkeletonText className="w-16" />
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The Changes card while it first loads. */
export function ValidatorTimelineSkeleton() {
  const { pinned } = useAtRound()
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-x-2">
          <CardTitle>Changes</CardTitle>
          {/* The target select */}
          <div className="-my-2.5 h-9 w-[170px] animate-pulse rounded-md bg-muted" />
        </div>
        <TimelineNote pinned={pinned} />
      </CardHeader>
      <CardContent>
        <TimelineRowsSkeleton />
      </CardContent>
    </Card>
  )
}
