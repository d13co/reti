import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import * as React from 'react'
import { latestRoundQueryOptions } from '@/api/history'
import { roundTimestampQueryOptions, timeReader, timeTravelSupportQueryOptions } from '@/api/reti'
import { roundAsOf, roundAtTime } from '@/api/roundTimes'
import { traceQuery } from '@/api/trace'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Warp, type WarpHandle } from '@/components/TimeTravel/Warp'
import { usePendingRound } from '@/hooks/useAtRound'
import { useSetRound } from '@/hooks/useSetRound'
import { dayjs } from '@/utils/dayjs'
import { parseRound } from '@/utils/round'
import { cn } from '@/utils/ui'

interface TimeTravelControlProps {
  className?: string
}

/**
 * The header's time travel control: pick a date and time (or a round) to see every page as it was
 * then. Only offered when the read node can serve past rounds.
 */
export function TimeTravelControl({ className }: TimeTravelControlProps) {
  const queryClient = useQueryClient()
  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  const { round, pinned } = usePendingRound()
  const roundTimeQuery = useQuery(roundTimestampQueryOptions(round))
  const setRound = useSetRound()

  const [isOpen, setIsOpen] = React.useState(false)
  const [date, setDate] = React.useState<Date | undefined>()
  // Controlled, so the calendar opens on the month being shown rather than the current one
  const [month, setMonth] = React.useState<Date>(new Date())
  const [time, setTime] = React.useState('12:00')
  const [roundInput, setRoundInput] = React.useState('')
  const [error, setError] = React.useState<string>()
  const [isBusy, setIsBusy] = React.useState(false)
  // The starfield over the page while "Go to date" travels, and where to
  const [warp, setWarp] = React.useState<string>()
  const warpHandle = React.useRef<WarpHandle>(null)
  const [warpKey, setWarpKey] = React.useState(0)
  const warpRef = React.useRef(0)

  // The search in flight. A new one, closing the popover, Escape during the warp or unmounting
  // cancels it, so a search that lands late never moves the page.
  const searchRef = React.useRef<AbortController>()
  const cancelSearch = React.useCallback(() => {
    searchRef.current?.abort()
    searchRef.current = undefined
    setIsBusy(false)
  }, [])
  React.useEffect(() => cancelSearch, [cancelSearch])

  // Closed by the user (outside click, Escape), not by "Go to date", which closes it as it starts
  const onOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) cancelSearch()
  }

  // The warp leaves no popover to close, so Escape stops it
  const warping = warp !== undefined
  React.useEffect(() => {
    if (!warping) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelSearch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [warping, cancelSearch])

  // Reopened to show why "Go to date" failed: keep the date picked and the error
  const reopenedRef = React.useRef(false)

  // Start the picker from what's on screen
  React.useEffect(() => {
    if (!isOpen) return
    if (reopenedRef.current) {
      reopenedRef.current = false
      return
    }
    setError(undefined)
    const shown = roundTimeQuery.data ? dayjs.unix(roundTimeQuery.data) : dayjs()
    setDate(shown.toDate())
    setMonth(shown.toDate())
    setTime(shown.format('HH:mm'))
    setRoundInput(round?.toString() ?? '')
  }, [isOpen, round, roundTimeQuery.data])

  const support = supportQuery.data
  if (!support?.supported) {
    return null
  }

  const earliest =
    support.creationTimestamp !== undefined ? dayjs.unix(support.creationTimestamp) : undefined

  /**
   * Moves the page to the round `target` finds; whether it did, failed or was cancelled.
   * `onFound` is called once the round is found, as the page starts moving to it.
   */
  const go = async (
    target: (signal: AbortSignal) => Promise<bigint | undefined>,
    onFound?: () => void,
  ): Promise<'moved' | 'failed' | 'cancelled'> => {
    cancelSearch()
    const search = new AbortController()
    searchRef.current = search
    const { signal } = search
    setIsBusy(true)
    setError(undefined)
    try {
      const round = await target(signal)
      signal.throwIfAborted()
      onFound?.()
      await setRound(round)
      if (searchRef.current === search) setIsOpen(false)
      return 'moved'
    } catch (e) {
      // Only the latest search reports: a cancelled one was replaced or closed
      if (signal.aborted) return 'cancelled'
      setError(e instanceof Error ? e.message : String(e))
      return 'failed'
    } finally {
      if (searchRef.current === search) {
        searchRef.current = undefined
        setIsBusy(false)
      }
    }
  }

  const goToDate = async () => {
    if (!date) return
    const [hours, minutes] = time.split(':').map(Number)
    const when = dayjs(date)
      .hour(hours || 0)
      .minute(minutes || 0)
      .second(0)
      .millisecond(0)
    const now = !when.isBefore(dayjs())

    const started = performance.now()
    const jump = ++warpRef.current
    // Out of the way of the warp at once; the search goes on
    setIsOpen(false)
    setWarp(now ? 'Now' : when.format('lll'))
    setWarpKey(jump)
    let onFound = () => {}
    const found = new Promise<void>((resolve) => (onFound = resolve))
    const result = go(
      async (signal) => {
        if (now) return undefined // now or later: the latest state
        if (earliest && when.isBefore(earliest)) {
          throw new Error(`Réti was created on ${earliest.format('lll')}; pick a later time`)
        }
        const trace = traceQuery('go-to-date', signal)
        const first = await roundAtTime(trace, timeReader, when.toDate())
        const round = roundAsOf(first, when.unix(), support.creationRound)
        trace.done(`round=${round}`)
        return round
      },
      () => {
        // Found: gone by the cap however busy the page gets rendering it. Scheduled now, while
        // the main thread is free, as a compositor animation
        if (warpRef.current === jump) warpHandle.current?.fadeOutAt(started + WARP_MAX_MS)
        onFound()
      },
    )

    // The warp lasts until the round is found, then until the page at it loads, within
    // 0.5–1.1s of the click. A failed or cancelled search ends it at once.
    const searched = await Promise.race([result, found.then(() => 'found' as const)])
    if (searched === 'found') await warpUntilLoaded(queryClient, started, result)
    // A later jump keeps its own warp
    if (warpRef.current !== jump) return
    setWarp(undefined)
    if ((await result) === 'failed' && warpRef.current === jump) {
      reopenedRef.current = true
      setIsOpen(true)
    }
  }

  const goToRound = () =>
    go(async () => {
      const target = parseRound(roundInput)
      if (target === undefined) throw new Error('Enter a round number')
      if (support.creationRound !== undefined && target < support.creationRound) {
        throw new Error(`Réti was created at round ${support.creationRound.toLocaleString()}`)
      }
      const latest = await queryClient.fetchQuery(latestRoundQueryOptions)
      if (target >= latest) return undefined // the latest state
      return target
    })

  return (
    <>
      <Warp
        // A new overlay for each jump, so one fading out (or faded by its cap) isn't reused
        key={warpKey}
        ref={warpHandle}
        active={warp !== undefined}
        label={warp}
      />
      <Popover open={isOpen} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant={pinned ? 'default' : 'ghost'}
            size="sm"
            className={cn('gap-x-2', className)}
            aria-label="Time travel"
            data-test-id="time-travel-trigger"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">
              {pinned && roundTimeQuery.data
                ? dayjs.unix(roundTimeQuery.data).format('ll')
                : 'History'}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <div className="p-3 pb-0">
            <p className="text-sm font-medium">View Réti as of</p>
            <p className="text-xs text-muted-foreground">
              Every page shows that moment, read-only.
            </p>
          </div>
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            month={month}
            onMonthChange={setMonth}
            fromDate={earliest?.toDate()}
            toDate={new Date()}
            disabled={(day) =>
              dayjs(day).isAfter(dayjs(), 'day') ||
              (earliest !== undefined && dayjs(day).isBefore(earliest, 'day'))
            }
            initialFocus
          />
          <div className="space-y-3 border-t p-3">
            <form
              className="flex items-center gap-x-2"
              onSubmit={(e) => {
                e.preventDefault()
                goToDate()
              }}
            >
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-8 w-28"
                aria-label="Time"
              />
              <Button type="submit" size="sm" disabled={isBusy || !date} className="flex-1">
                Go to date
              </Button>
            </form>
            <form
              className="flex items-center gap-x-2"
              onSubmit={(e) => {
                e.preventDefault()
                goToRound()
              }}
            >
              <Input
                inputMode="numeric"
                placeholder="Round"
                value={roundInput}
                onChange={(e) => setRoundInput(e.target.value)}
                className="h-8 w-28 font-mono"
                aria-label="Round"
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={isBusy}
                className="flex-1"
              >
                Go to round
              </Button>
            </form>
            {error && <p className="max-w-[16rem] text-xs text-destructive">{error}</p>}
            {pinned && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={isBusy}
                onClick={() => go(async () => undefined)}
              >
                Back to now
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** The warp lasts at least this long, in ms from the click, so it reads as a jump */
const WARP_MIN_MS = 500
/** and no longer than this while the page at the new round loads */
const WARP_MAX_MS = 1100

/**
 * Once the round is found, holds the warp until the page at it has loaded: `moving` (the
 * navigation, with its route loaders) has settled and no reads are in flight. Within
 * WARP_MIN_MS and WARP_MAX_MS of `started`; a search slower than that ends it at once.
 */
async function warpUntilLoaded(
  queryClient: QueryClient,
  started: number,
  moving: Promise<unknown>,
) {
  const left = () => started + WARP_MAX_MS - performance.now()
  const loaded = moving
    // Let the page render and start its reads
    .then(() => sleep(Math.min(50, left())))
    .then(() => whenIdle(queryClient, left()))
  await Promise.race([loaded, sleep(left())])
  await sleep(started + WARP_MIN_MS - performance.now())
}

/** Resolves once no query is fetching, or after `timeoutMs`. */
function whenIdle(queryClient: QueryClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0 || queryClient.isFetching() === 0) return resolve()
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (queryClient.isFetching() === 0) done()
    })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(ms, 0)))
