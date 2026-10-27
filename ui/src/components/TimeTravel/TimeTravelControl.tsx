import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import { useAtRound } from '@/hooks/useAtRound'
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
  const { round, pinned } = useAtRound()
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

  // The search in flight. A new one, closing the popover or unmounting cancels it, so a search
  // that lands late never moves the page.
  const searchRef = React.useRef<AbortController>()
  const cancelSearch = React.useCallback(() => {
    searchRef.current?.abort()
    searchRef.current = undefined
  }, [])
  React.useEffect(() => cancelSearch, [cancelSearch])
  React.useEffect(() => {
    if (!isOpen) {
      cancelSearch()
      setIsBusy(false)
    }
  }, [isOpen, cancelSearch])

  // Start the picker from what's on screen
  React.useEffect(() => {
    if (!isOpen) return
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

  const go = async (target: (signal: AbortSignal) => Promise<bigint | undefined>) => {
    cancelSearch()
    const search = new AbortController()
    searchRef.current = search
    const { signal } = search
    setIsBusy(true)
    setError(undefined)
    try {
      const round = await target(signal)
      signal.throwIfAborted()
      await setRound(round)
      if (searchRef.current === search) setIsOpen(false)
    } catch (e) {
      // Only the latest search reports: a cancelled one was replaced or closed
      if (!signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (searchRef.current === search) {
        searchRef.current = undefined
        setIsBusy(false)
      }
    }
  }

  const goToDate = () =>
    go(async (signal) => {
      if (!date) throw new Error('Pick a date')
      const [hours, minutes] = time.split(':').map(Number)
      const when = dayjs(date)
        .hour(hours || 0)
        .minute(minutes || 0)
        .second(0)
        .millisecond(0)
      if (!when.isBefore(dayjs())) return undefined // now or later: the latest state
      if (earliest && when.isBefore(earliest)) {
        throw new Error(`Réti was created on ${earliest.format('lll')}; pick a later time`)
      }
      const trace = traceQuery('go-to-date', signal)
      const first = await roundAtTime(trace, timeReader, when.toDate())
      const round = roundAsOf(first, when.unix(), support.creationRound)
      trace.done(`round=${round}`)
      return round
    })

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
    <Popover open={isOpen} onOpenChange={setIsOpen}>
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
          <p className="text-xs text-muted-foreground">Every page shows that moment, read-only.</p>
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
  )
}
