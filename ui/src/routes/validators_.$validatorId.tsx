import { useQuery } from '@tanstack/react-query'
import { ErrorComponent, createFileRoute } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { ValidatorNotFoundError, fetchValidatorCoreData } from '@/api/contracts'
import {
  constraintsQueryOptions,
  stakesQueryOptions,
  validatorConfigQueryOptions,
  validatorStateQueryOptions,
  validatorPoolsQueryOptions,
  validatorNodePoolAssignmentsQueryOptions,
} from '@/api/queries'
import { Meta } from '@/components/Meta'
import { PageMain } from '@/components/PageMain'
import { ValidatorDetails } from '@/components/ValidatorDetails'
import { DetailsHeader } from '@/components/ValidatorDetails/DetailsHeader'
import { ValidatorDetailsSkeleton } from '@/components/ValidatorDetails/ValidatorDetails'
import { XGovSignUpBanner } from '@/components/XGovSignUpBanner'
import { useAtRound } from '@/hooks/useAtRound'
import { useValidator } from '@/hooks/useValidator'
import { setValidatorCoreQueriesData } from '@/utils/contracts'
import {
  isRoundUnavailable,
  keepAcrossRounds,
  parseRound,
  roundUnavailableMessage,
} from '@/utils/round'

export const Route = createFileRoute('/validators_/$validatorId')({
  loaderDeps: ({ search }) => ({ round: search.round }),
  loader: async ({ context: { queryClient }, params, deps }) => {
    const validatorId = Number(params.validatorId)
    const round = parseRound(deps.round)

    // Moving to another round of a validator already on screen: don't hold the page. It keeps
    // showing the round it has, with each section marked as loading, until this one arrives.
    const configKey = validatorConfigQueryOptions(validatorId, round).queryKey
    const shownAtAnotherRound = queryClient
      .getQueriesData({ queryKey: configKey.slice(0, -1) })
      .some(([, data]) => data !== undefined)
    if (queryClient.getQueryData(configKey) === undefined && shownAtAnotherRound) {
      return
    }

    try {
      // All four come from the same read. Seed them from it when arriving cold (deep link /
      // refresh); navigating from the dashboard leaves them already cached.
      if (queryClient.getQueryData(configKey) === undefined) {
        setValidatorCoreQueriesData(
          queryClient,
          await fetchValidatorCoreData(validatorId, round),
          round,
        )
      }

      await Promise.all([
        queryClient.ensureQueryData(validatorConfigQueryOptions(validatorId, round)),
        queryClient.ensureQueryData(validatorStateQueryOptions(validatorId, round)),
        queryClient.ensureQueryData(validatorPoolsQueryOptions(validatorId, round)),
        queryClient.ensureQueryData(validatorNodePoolAssignmentsQueryOptions(validatorId, round)),
      ])
    } catch (error) {
      if (isRoundUnavailable(error)) {
        throw error
      }
      throw notFound(validatorId, round, error)
    }
  },
  component: Dashboard,
  // Shown only on a slow first load: the page's own layout, with its figures to come
  pendingComponent: PageSkeleton,
  pendingMs: 150,
  errorComponent: ({ error }) => {
    if (isRoundUnavailable(error)) {
      return <Unavailable message={roundUnavailableMessage(error)} />
    }
    if (error instanceof ValidatorNotFoundError) {
      return <Unavailable message={error.message} />
    }
    return <ErrorComponent error={error} />
  },
})

/** Why there's no validator to show, where the page would be. */
function Unavailable({ message }: { message: string }) {
  return (
    <PageMain>
      <p className="py-10 text-muted-foreground">{message}</p>
    </PageMain>
  )
}

function notFound(validatorId: number, round: bigint | undefined, error: unknown) {
  const when = round === undefined ? '' : ` at round ${round}`
  return new ValidatorNotFoundError(
    `Validator with id "${validatorId}" not found${when}! Error: ${error}`,
  )
}

function PageSkeleton() {
  return (
    <>
      <DetailsHeader />
      <PageMain>
        <ValidatorDetailsSkeleton />
      </PageMain>
    </>
  )
}

function Dashboard() {
  const { validatorId } = Route.useParams()
  const { round, pinned } = useAtRound()
  const { validator, refreshing, error, nfdPending } = useValidator(Number(validatorId))
  const { activeAddress } = useWallet()

  const constraintsQuery = useQuery(keepAcrossRounds(constraintsQueryOptions(round)))
  const stakesQuery = useQuery(keepAcrossRounds(stakesQueryOptions(activeAddress, round)))
  const stakesByValidator = stakesQuery.data || []

  // The round asked for couldn't load: say, the validator didn't exist yet
  if (!validator && error) {
    const message =
      error instanceof ValidatorNotFoundError
        ? notFound(Number(validatorId), round, error.message).message
        : error.message
    return <Unavailable message={message} />
  }

  if (!validator || !constraintsQuery.data) {
    return <PageSkeleton />
  }

  const pageTitle = validator.nfd ? validator.nfd.name : `Validator ${validatorId}`

  return (
    <>
      <Meta title={pageTitle} />
      {/* Signing up for xGov is a write, and xGov state isn't read at past rounds */}
      {!pinned && <XGovSignUpBanner validator={validator} />}
      <DetailsHeader validator={validator} nfdPending={nfdPending} />
      <PageMain>
        <ValidatorDetails
          validator={validator}
          constraints={constraintsQuery.data}
          stakesByValidator={stakesByValidator}
          refreshing={refreshing || constraintsQuery.isPlaceholderData}
          nfdPending={nfdPending}
        />
      </PageMain>
    </>
  )
}
