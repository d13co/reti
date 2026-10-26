import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import algosdk from 'algosdk'
import { History, MessageCircleWarning } from 'lucide-react'
import * as React from 'react'
import {
  stakerHistoryQueryOptions,
  type StakeEvent,
  type StakerPoolMembership,
} from '@/api/history'
import { allValidatorsQueryOptions, nfdLookupQueryOptions, nfdQueryOptions } from '@/api/queries'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { ErrorAlert } from '@/components/ErrorAlert'
import { Loading } from '@/components/Loading'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { PageMain } from '@/components/PageMain'
import { RefreshOverlay } from '@/components/RefreshOverlay'
import { StakeHistoryNote, StakeHistoryTable } from '@/components/StakeHistory/StakeHistoryTable'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SkeletonText } from '@/components/ui/skeleton'
import { useAtRound } from '@/hooks/useAtRound'
import { useStakerHistory, useStakerPools } from '@/hooks/useStakerHistory'
import { parseRound } from '@/utils/round'

export const Route = createFileRoute('/history/$address')({
  beforeLoad: ({ context: { queryClient }, params, search }) => {
    if (!algosdk.isValidAddress(params.address)) return
    const round = parseRound(search.round)
    // Start the reads now, without holding the page: it fills in as they land
    void queryClient.prefetchQuery(allValidatorsQueryOptions(queryClient, round))
    void queryClient
      .ensureQueryData(timeTravelSupportQueryOptions)
      .then(({ supported }) =>
        supported
          ? queryClient.prefetchQuery(stakerHistoryQueryOptions(queryClient, params.address, round))
          : undefined,
      )
      // The page shows the support check's own error, if any
      .catch(() => {})
  },
  component: StakingHistory,
})

type KindFilter = 'all' | StakeEvent['kind']

/** Skeleton rows while the first events load, and under them while more may arrive. */
const LOADING_ROWS = { first: 6, more: 2 }

function StakingHistory() {
  const { address } = Route.useParams()
  const valid = algosdk.isValidAddress(address)
  const nfdQuery = useQuery({ ...nfdLookupQueryOptions(address), enabled: valid })
  const description = nfdQuery.data?.name ?? address

  return (
    <>
      <Meta title="Staking History" />
      <PageHeader title="Staking History" description={valid ? description : undefined} />
      <PageMain>
        {valid ? (
          <HistoryBody address={address} />
        ) : (
          <div className="py-10">
            <ErrorAlert
              title="Invalid address"
              message={`"${address}" isn't an Algorand address.`}
            />
          </div>
        )}
      </PageMain>
    </>
  )
}

function HistoryBody({ address }: { address: string }) {
  const queryClient = useQueryClient()
  const { round } = useAtRound()
  const { query, supported } = useStakerHistory(address)
  const poolsQuery = useStakerPools(address)
  const validatorsQuery = useQuery(allValidatorsQueryOptions(queryClient, round))

  const [validatorFilter, setValidatorFilter] = React.useState('all')
  const [kindFilter, setKindFilter] = React.useState<KindFilter>('all')

  const history = query.data
  // The full history's pools, else the pools read on their own, whichever lands first
  const pools = history?.pools ?? poolsQuery.data

  const events = React.useMemo(
    () =>
      (history?.events ?? []).filter(
        (event) =>
          (validatorFilter === 'all' || String(event.validatorId) === validatorFilter) &&
          (kindFilter === 'all' || event.kind === kindFilter),
      ),
    [history?.events, validatorFilter, kindFilter],
  )

  const validatorIds = [...new Set((pools ?? []).map((pool) => Number(pool.validatorId)))].sort(
    (a, b) => a - b,
  )
  const validatorNames = useValidatorNames(validatorIds, validatorsQuery.data)

  if (supported === false) {
    return (
      <div className="py-10">
        <Alert className="max-w-xl">
          <MessageCircleWarning className="h-5 w-5 -mt-1" />
          <AlertTitle>History isn&apos;t available</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Staking history is rebuilt from past on-chain state, which needs a read node with time
            travel. This node only serves the latest state.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const complete = !!history?.complete
  const loadingRows = complete ? 0 : events.length === 0 ? LOADING_ROWS.first : LOADING_ROWS.more

  return (
    <div className="py-10 space-y-6">
      <Summary events={history?.events} complete={complete} pools={pools} />

      {query.isError && (
        <ErrorAlert
          title="Couldn't load the whole history"
          message={query.error instanceof Error ? query.error.message : String(query.error)}
        />
      )}

      <div className="relative space-y-3" aria-busy={query.isPlaceholderData}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex flex-1 items-center gap-x-2 text-lg font-semibold">
            <History className="h-5 w-5 text-muted-foreground" aria-hidden />
            Deposits and withdrawals
            {!complete && !query.isError && <Loading size="sm" inline className="ml-1" />}
          </h2>
          <Select value={validatorFilter} onValueChange={setValidatorFilter}>
            <SelectTrigger className="w-[220px]" aria-label="Filter by validator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All validators</SelectItem>
              {validatorIds.map((id) => (
                <SelectItem key={id} value={String(id)}>
                  {validatorNames.get(id) ?? `Validator ${id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={kindFilter} onValueChange={(value) => setKindFilter(value as KindFilter)}>
            <SelectTrigger className="w-[150px]" aria-label="Filter by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="deposit">Deposits</SelectItem>
              <SelectItem value="withdrawal">Withdrawals</SelectItem>
              <SelectItem value="mixed">Mixed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!complete && !query.isError && <ProgressLine progress={history?.progress} />}
        <StakeHistoryTable
          events={events}
          showValidator
          validators={validatorsQuery.data}
          loadingRows={query.isError ? 0 : loadingRows}
        />
        <StakeHistoryNote />
        <RefreshOverlay active={query.isPlaceholderData} />
      </div>
    </div>
  )
}

/**
 * The NFD names of validators that have one, by id, as they resolve. Shares its lookups with the
 * table's names (same queries), so it adds no requests.
 */
function useValidatorNames(
  validatorIds: number[],
  validators?: { id: number; config: { nfdForInfo: bigint } }[],
): Map<number, string> {
  const nfdAppIds = validatorIds.map(
    (id) => validators?.find((v) => v.id === id)?.config.nfdForInfo ?? 0n,
  )
  const nfdQueries = useQueries({
    queries: nfdAppIds.map((nfdAppId) => ({
      ...nfdQueryOptions(nfdAppId),
      enabled: nfdAppId > 0n,
      // A slot never shows another validator's name while its own loads
      placeholderData: undefined,
    })),
  })
  const names = new Map<number, string>()
  nfdQueries.forEach((query, i) => {
    if (nfdAppIds[i] > 0n && query.data?.name) names.set(validatorIds[i], query.data.name)
  })
  return names
}

function ProgressLine({ progress }: { progress?: { pools: number; poolsDone: number } }) {
  const text = !progress
    ? 'Finding the pools this account has been in…'
    : progress.pools === 0
      ? 'Finishing…'
      : `Reading ${progress.pools - progress.poolsDone} of ${progress.pools} ${progress.pools === 1 ? 'pool' : 'pools'}…`
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {text}
    </p>
  )
}

interface SummaryProps {
  events?: StakeEvent[]
  complete: boolean
  pools?: StakerPoolMembership[]
}

/** Totals, once the history is complete; the validators used as soon as the pools are known. */
function Summary({ events, complete, pools }: SummaryProps) {
  const total = (kind: StakeEvent['kind']) =>
    (events ?? []).filter((event) => event.kind === kind).reduce((sum, e) => sum + e.amount, 0n)

  const current = new Set(
    (pools ?? []).filter((p) => p.leaveRound === undefined).map((p) => p.validatorId),
  )
  const past = new Set(
    (pools ?? []).filter((p) => !current.has(p.validatorId)).map((p) => p.validatorId),
  )

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SummaryCard title="Total deposited">
        {complete ? (
          <AlgoDisplayAmount amount={total('deposit')} microalgos mutedRemainder />
        ) : (
          <SkeletonText className="w-32" />
        )}
      </SummaryCard>
      <SummaryCard title="Total withdrawn">
        {complete ? (
          <AlgoDisplayAmount amount={total('withdrawal')} microalgos mutedRemainder />
        ) : (
          <SkeletonText className="w-32" />
        )}
      </SummaryCard>
      <SummaryCard title="Validators">
        {pools ? (
          <span>
            {current.size} current
            <span className="text-muted-foreground"> · {past.size} past</span>
          </span>
        ) : (
          <SkeletonText className="w-28" />
        )}
      </SummaryCard>
    </div>
  )
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold">{children}</CardContent>
    </Card>
  )
}
