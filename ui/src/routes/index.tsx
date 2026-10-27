import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import * as React from 'react'
import { seriesExtentQueryOptions } from '@/api/history'
import {
  allValidatorsQueryOptions,
  constraintsQueryOptions,
  stakesQueryOptions,
} from '@/api/queries'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { Loading } from '@/components/Loading'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { PageMain } from '@/components/PageMain'
import { StakingTable } from '@/components/StakingTable'
import { TotalsHistory } from '@/components/TimeTravel/TotalsHistory'
import { ValidatorTable } from '@/components/ValidatorTable'
import { useAtRound } from '@/hooks/useAtRound'
import { useValidators } from '@/hooks/useValidators'
import { StakerValidatorData } from '@/interfaces/staking'
import { ValidatorModalsProvider } from '@/providers/ValidatorModalsProvider'
import { parseRound } from '@/utils/round'

const REGISTRY = { registry: true } as const

/** Stable while there are no stakes, so the memoized tables don't re-render for a new `[]` */
const NO_STAKES: StakerValidatorData[] = []

export const Route = createFileRoute('/')({
  beforeLoad: ({ context: { queryClient, walletManager }, search }) => {
    const round = parseRound(search.round)

    // The connected account's own stakes go first, alongside the validator set the table names
    // them from; the page would otherwise only ask once the validator set had loaded
    const address = walletManager.activeAddress
    const ownStakes = address
      ? queryClient.prefetchQuery(stakesQueryOptions(address, round))
      : Promise.resolve()

    // Then the history charts: their first read goes out from here rather than once the page has
    // rendered. Not awaited; the charts pick it up from the cache.
    void ownStakes
      .then(() => queryClient.ensureQueryData(timeTravelSupportQueryOptions))
      .then(({ supported }) =>
        supported
          ? queryClient.prefetchQuery(seriesExtentQueryOptions(REGISTRY, round))
          : undefined,
      )
      // The charts show the support check's own error, if any
      .catch(() => {})

    // Prefetch every validator's core data in a single request
    const options = allValidatorsQueryOptions(queryClient, round)
    const prefetch = queryClient.prefetchQuery(options)

    // Only a cold cache is worth blocking the route on. When the persisted cache was restored
    // the table paints from it immediately and this refresh lands underneath it.
    return queryClient.getQueryData(options.queryKey) ? undefined : prefetch
  },
  component: Dashboard,
  pendingComponent: () => <Loading size="lg" className="opacity-50" flex />,
  errorComponent: ({ error }) => {
    if (error instanceof Error) {
      return <div>{error?.message}</div>
    }
    return <div>Error loading validator data</div>
  },
})

function Dashboard() {
  const { activeAddress } = useWallet()
  const { round } = useAtRound()

  const constraintsQuery = useSuspenseQuery(constraintsQueryOptions(round))
  const constraints = constraintsQuery.data

  const {
    validators: latestValidators,
    isLoading: validatorsLoading,
    error: validatorsError,
  } = useValidators()
  // Names, metrics and APYs land in many small batches after the first paint. Deferred, the
  // tables re-render for them in the background, where React can drop the batches it falls behind
  // on and clicks and typing go first.
  const validators = React.useDeferredValue(latestValidators)

  const stakesQuery = useQuery(stakesQueryOptions(activeAddress, round))
  const stakesByValidator = stakesQuery.data ?? NO_STAKES

  if (validatorsError) {
    return <div>Error loading validators: {validatorsError.message}</div>
  }

  return (
    <>
      <Meta title="Dashboard" />
      <PageHeader
        title="Staking Dashboard"
        description="Browse validators in the protocol and manage your staking activity."
        separator
      />
      <PageMain>
        <ValidatorModalsProvider stakesByValidator={stakesByValidator} constraints={constraints}>
          <div className="space-y-8">
            <StakingTable
              validators={validators}
              stakesByValidator={stakesByValidator}
              constraints={constraints}
              isLoading={validatorsLoading || stakesQuery.isLoading}
            />
            <TotalsHistory target={REGISTRY} title="Protocol history" />
            <ValidatorTable
              validators={validators}
              stakesByValidator={stakesByValidator}
              constraints={constraints}
              isLoading={validatorsLoading}
            />
          </div>
        </ValidatorModalsProvider>
      </PageMain>
    </>
  )
}
