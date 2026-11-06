import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import * as React from 'react'
import { adjacentChangesQueryOptions, latestRoundQueryOptions, TimelineTarget } from '@/api/history'
import { nfdSupportQueryOptions } from '@/api/queries'
import { roundTimestampQueryOptions, timeTravelSupportQueryOptions } from '@/api/reti'
import { Tooltip } from '@/components/Tooltip'
import { Button } from '@/components/ui/button'
import { usePendingRound } from '@/hooks/useAtRound'
import { useSetRound } from '@/hooks/useSetRound'
import { dayjs } from '@/utils/dayjs'

/** On the red banner: white, with the banner's red as text */
const NOW_BUTTON =
  'bg-primary-foreground font-semibold text-primary shadow-sm hover:bg-primary-foreground/90'

const STEP_BUTTON =
  'h-8 w-8 text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground disabled:opacity-40'

/**
 * Shown under the header while time travelling: what moment the app is showing, stepping through
 * the changes of what's on the page, and the way back to now. It sticks just below the header
 * (`h-16`, so `top-16`) and is sized to the same height on wide screens.
 */
export function TimeTravelBanner() {
  // Where the app is going, from the moment it starts going: the page's own data follows
  const { round, pinned } = usePendingRound()
  const setRound = useSetRound()
  const params = useParams({ strict: false }) as { validatorId?: string }

  const supportQuery = useQuery({ ...timeTravelSupportQueryOptions, enabled: pinned })
  const roundTimeQuery = useQuery(roundTimestampQueryOptions(round))
  const latestRoundQuery = useQuery({ ...latestRoundQueryOptions, enabled: pinned })
  const nfdSupportQuery = useQuery({ ...nfdSupportQueryOptions, enabled: pinned })

  // Step through the changes of the validator on screen, else of the registry as a whole
  const target: TimelineTarget = React.useMemo(
    () => (params.validatorId ? { validator: Number(params.validatorId) } : { registry: true }),
    [params.validatorId],
  )
  const targetName = params.validatorId ? `validator ${params.validatorId}` : 'the registry'

  const creationRound = supportQuery.data?.creationRound
  const beforeCreation = round !== undefined && creationRound !== undefined && round < creationRound

  const adjacentQuery = useQuery({
    ...adjacentChangesQueryOptions(target, round ?? 0n),
    enabled: pinned && !!supportQuery.data?.supported && !beforeCreation,
  })

  // A round that hasn't happened yet is just "now"
  const latestRound = latestRoundQuery.data
  React.useEffect(() => {
    if (round !== undefined && latestRound !== undefined && round >= latestRound) {
      setRound(undefined)
    }
  }, [round, latestRound, setRound])

  if (!pinned || round === undefined) {
    return null
  }

  const shownAt = roundTimeQuery.data ? dayjs.unix(roundTimeQuery.data).format('lll') : '…'
  const { previous, next } = adjacentQuery.data ?? {}

  return (
    <div
      role="status"
      className="sticky top-16 z-40 bg-primary text-primary-foreground shadow-lg"
      data-test-id="time-travel-banner"
    >
      {/* Phones: the title on its own row, then the round beside the buttons. Wider: the icon and
          buttons span both text lines. */}
      <div className="mx-auto grid min-h-16 max-w-7xl grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:gap-x-4 sm:gap-y-0 sm:px-6 lg:px-8">
        <History className="h-6 w-6 shrink-0 sm:row-span-2" aria-hidden />
        {beforeCreation ? (
          <p className="col-span-2 text-sm font-semibold sm:col-span-1 sm:row-span-2 sm:text-base">
            Réti didn&apos;t exist yet at round {round.toLocaleString()}. It was created at round{' '}
            {creationRound.toLocaleString()}.
          </p>
        ) : (
          <>
            <p className="col-span-2 min-w-0 text-base font-bold leading-tight sm:col-span-1 sm:text-lg">
              Viewing Réti as of {shownAt}
            </p>
            <p className="col-start-2 row-start-2 flex min-w-0 flex-col text-xs text-primary-foreground/85 sm:block sm:text-sm">
              <span className="font-mono">Round {round.toLocaleString()}</span>
              <span>
                <span className="hidden sm:inline"> · </span>
                {/* Each sentence stays whole, so a narrow phone breaks between them */}
                <span className="whitespace-nowrap">Read only.</span>
                {/* Only where the read node can't read NFDs, or couldn't be asked (see `@/api/nfd`) */}
                {(nfdSupportQuery.data === false || nfdSupportQuery.isError) && (
                  <>
                    {' '}
                    <span className="whitespace-nowrap">NFDs unavailable.</span>
                  </>
                )}
              </span>
            </p>
          </>
        )}
        <div className="col-start-3 row-start-2 flex items-center justify-end gap-x-1.5 sm:row-span-2 sm:row-start-1">
          {beforeCreation ? (
            <Button size="sm" className={NOW_BUTTON} onClick={() => setRound(creationRound)}>
              Go to creation
            </Button>
          ) : (
            <>
              <Tooltip content={`Previous change to ${targetName}`}>
                <Button
                  size="icon"
                  variant="ghost"
                  className={STEP_BUTTON}
                  aria-label={`Previous change to ${targetName}`}
                  disabled={previous === undefined}
                  onClick={() => setRound(previous)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </Tooltip>
              <Tooltip content={`Next change to ${targetName}`}>
                <Button
                  size="icon"
                  variant="ghost"
                  className={STEP_BUTTON}
                  aria-label={`Next change to ${targetName}`}
                  disabled={next === undefined}
                  onClick={() => setRound(next)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Tooltip>
            </>
          )}
          <Button size="sm" className={NOW_BUTTON} onClick={() => setRound(undefined)}>
            Back to now
          </Button>
        </div>
      </div>
    </div>
  )
}
