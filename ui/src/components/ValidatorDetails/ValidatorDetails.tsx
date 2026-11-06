import { useQuery } from '@tanstack/react-query'
import { EventProps } from '@tremor/react'
import { useAtRound, useViewedTime, useWriteAddress } from '@/hooks/useAtRound'
import * as React from 'react'
import { validatorNodePoolAssignmentsQueryOptions } from '@/api/queries'
import { AddPoolModal } from '@/components/AddPoolModal'
import { AddStakeModal } from '@/components/AddStakeModal'
import { ErrorAlert } from '@/components/ErrorAlert'
import { TotalsHistory, TotalsHistorySkeleton } from '@/components/TimeTravel/TotalsHistory'
import { PoolIcon } from '@/components/PoolIcon'
import { RefreshOverlay } from '@/components/RefreshOverlay'
import { Button } from '@/components/ui/button'
import { Card, CardTitle, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UnstakeModal } from '@/components/UnstakeModal'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { useStakersChartData } from '@/hooks/useStakersChartData'
import { StakerValidatorData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'
import {
  isStakingDisabled,
  isSunsetted,
  isSunsetting,
  isUnstakingDisabled,
  validatorHasAvailableSlots,
} from '@/utils/contracts'
import { convertFromBaseUnits } from '@/utils/format'
import { getPoolIndexFromName, getPoolNameFromIndex } from '@/utils/pools'
import { cn } from '@/utils/ui'
import { Details, DetailsSkeleton } from './Details'
import { Highlights } from './Highlights'
import { PoolsChart } from './PoolsChart'
import { SelectPool } from './SelectPool'
import { StakingPoolInfo, StakingPoolInfoSkeleton } from './StakingPoolInfo'
import { StakersList } from './StakersList'
import { SunsetNotice } from './SunsetNotice'
import { ValidatorTimeline, ValidatorTimelineSkeleton } from './ValidatorTimeline'
import { YourHistory } from './YourHistory'

interface ValidatorDetailsProps {
  validator: Validator
  stakesByValidator: StakerValidatorData[]
  constraints: Constraints
  /** What's on screen is from the previous round while this one loads */
  refreshing?: boolean
  /** The validator has an NFD that hasn't loaded yet */
  nfdPending?: boolean
}

export function ValidatorDetails({
  validator,
  constraints,
  stakesByValidator,
  refreshing = false,
  nfdPending = false,
}: ValidatorDetailsProps) {
  const [selectedPool, setSelectedPool] = React.useState<string>(
    validator?.pools.length > 0 ? '0' : 'all',
  )
  const [addPoolValidator, setAddPoolValidator] = React.useState<Validator | null>(null)
  const [addStakeValidator, setAddStakeValidator] = React.useState<Validator | null>(null)
  const [unstakeValidator, setUnstakeValidator] = React.useState<Validator | null>(null)

  // Null while time travelling, which disables every write below
  const writeAddress = useWriteAddress()
  const { round } = useAtRound()
  // Re-renders when a past round's time lands, which the sunset checks below read
  useViewedTime()

  const isManager = validator.config.manager === writeAddress
  const isOwner = validator.config.owner === writeAddress
  const canEdit = isManager || isOwner
  const stakingDisabled = isStakingDisabled(writeAddress, validator, constraints)
  const unstakingDisabled = isUnstakingDisabled(writeAddress, validator, stakesByValidator)

  const {
    stakersChartData,
    poolsInfo,
    isLoading,
    refreshing: stakersRefreshing,
    errorMessage,
    refetchAll,
  } = useStakersChartData({
    selectedPool,
    validatorId: validator.id,
    pauseRefetch: !!addPoolValidator, // Pause refetch when adding pool
  })

  const { data: poolAssignment } = useQuery(
    validatorNodePoolAssignmentsQueryOptions(validator.id, round, canEdit),
  )

  const validatorHasSlots = React.useMemo(() => {
    return poolAssignment
      ? validatorHasAvailableSlots(poolAssignment, validator.config.poolsPerNode)
      : false
  }, [poolAssignment, validator.config.poolsPerNode])

  const canAddPool = canEdit && validatorHasSlots

  // If pool has no stake, set value to 1 microalgo so it appears in the donut chart (as a 1px sliver)
  const poolData =
    validator?.pools.map((pool, index) => ({
      name: `Pool ${index + 1}`,
      value: convertFromBaseUnits(Number(pool.totalAlgoStaked || 1n), 6),
    })) || []

  const selectedPoolInfo = selectedPool === 'all' ? null : poolsInfo[Number(selectedPool)]
  const selectedPoolName = getPoolNameFromIndex(selectedPool)

  // After successfully adding a pool
  const handleAddPoolClose = React.useCallback(
    async (success?: boolean) => {
      if (success) {
        await refetchAll() // Invalidate/refetch stakers chart data
        setSelectedPool('0') // Select the first pool
      }
    },
    [refetchAll],
  )

  const handlePoolClick = (eventProps: EventProps) => {
    const selected = !eventProps ? 'all' : getPoolIndexFromName(eventProps.name, true)
    setSelectedPool(selected)
  }

  const poolsChartContainerRef = React.useRef<HTMLDivElement>(null)

  // The pools' figures and APY come with the validator; the stakers load on their own
  const stakingRefreshing = refreshing || stakersRefreshing

  const renderStakingDetails = () => {
    if (isLoading) {
      return <StakingDetailsSkeleton />
    }

    if (errorMessage) {
      return <ErrorAlert title="Failed to load staking data" message={errorMessage} />
    }

    return (
      <Card className="relative" aria-busy={stakingRefreshing}>
        <CardHeader>
          <CardTitle as="h2" className="flex items-start justify-between gap-x-2">
            Staking Details
            {poolsInfo.length > 0 && (
              <SelectPool
                selectedPool={selectedPool}
                onValueChange={setSelectedPool}
                poolsInfo={poolsInfo}
                chartContainerRef={poolsChartContainerRef}
              />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="mt-2.5 mb-4 space-y-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div
              ref={poolsChartContainerRef}
              className="self-start py-2 flex items-center justify-center"
            >
              {poolData.filter((data) => data.value > 0.000001).length > 0 ? (
                <PoolsChart
                  data={poolData}
                  onValueChange={handlePoolClick}
                  className="w-52 h-52 sm:w-64 sm:h-64"
                />
              ) : (
                <div className="flex items-center justify-center w-52 h-52 sm:w-64 sm:h-64 rounded-tremor-default border border-tremor-border dark:border-dark-tremor-border">
                  {canAddPool && validator.pools.length === 0 ? (
                    <Button onClick={() => setAddPoolValidator(validator)}>
                      <PoolIcon className="-ml-0.5 mr-1.5 h-4 w-4" />
                      Add Pool 1
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">No ALGO staked</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center">
              <StakingPoolInfo
                validator={validator}
                constraints={constraints}
                poolInfo={selectedPoolInfo}
                poolName={selectedPoolName}
                isOwner={isOwner}
              />
            </div>
          </div>

          {isSunsetting(validator) && <SunsetNotice validator={validator} />}

          <StakersList chartData={stakersChartData} />
        </CardContent>
        <CardFooter
          className={cn('flex flex-col items-stretch gap-2 sm:flex-row sm:justify-end', {
            hidden: !writeAddress,
          })}
        >
          {!isSunsetted(validator) && (
            <Button onClick={() => setAddStakeValidator(validator)} disabled={stakingDisabled}>
              Add Stake
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => setUnstakeValidator(validator)}
            disabled={unstakingDisabled}
          >
            Unstake
          </Button>
        </CardFooter>
        <RefreshOverlay active={stakingRefreshing} tall />
      </Card>
    )
  }

  return (
    <ValidatorDetailsLayout
      highlights={
        <Highlights
          validator={validator}
          constraints={constraints}
          setAddPoolValidator={setAddPoolValidator}
          canAddPool={canAddPool}
          refreshing={refreshing}
        />
      }
      details={
        <Details
          validator={validator}
          constraints={constraints}
          refreshing={refreshing}
          nfdPending={nfdPending}
        />
      }
      staking={
        <>
          {renderStakingDetails()}
          <YourHistory validator={validator} />
        </>
      }
      history={<TotalsHistory target={{ validator: validator.id }} title="History" stacked />}
      timeline={<ValidatorTimeline validator={validator} />}
    >
      {canAddPool && (
        <AddPoolModal
          validator={addPoolValidator}
          setValidator={setAddPoolValidator}
          poolAssignment={poolAssignment}
          onClose={handleAddPoolClose}
        />
      )}
      <AddStakeModal
        validator={addStakeValidator}
        setValidator={setAddStakeValidator}
        stakesByValidator={stakesByValidator}
        constraints={constraints}
      />
      <UnstakeModal
        validator={unstakeValidator}
        setValidator={setUnstakeValidator}
        stakesByValidator={stakesByValidator}
      />
    </ValidatorDetailsLayout>
  )
}

interface ValidatorDetailsLayoutProps {
  highlights: React.ReactNode
  details: React.ReactNode
  staking: React.ReactNode
  history: React.ReactNode
  timeline: React.ReactNode
  children?: React.ReactNode
}

/** Where each section goes: shared by the page and its skeleton, so they line up. */
function ValidatorDetailsLayout({
  highlights,
  details,
  staking,
  history,
  timeline,
  children,
}: ValidatorDetailsLayoutProps) {
  return (
    <div className="py-10 space-y-4">
      {highlights}
      {/*
       * Two columns on large screens. Below that the columns dissolve (`contents`) into one, where
       * `order` moves History down after Staking Details, just above Changes. History and Changes
       * only render when the read node can serve past rounds; their empty boxes are hidden.
       */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="contents lg:block lg:space-y-4">
          <div>{details}</div>
          <div className="order-1 empty:hidden lg:order-none">{history}</div>
        </div>
        <div className="contents lg:col-span-2 lg:block lg:space-y-4">
          <div className="space-y-4">{staking}</div>
          <div className="order-2 empty:hidden lg:order-none">{timeline}</div>
        </div>
      </div>
      {children}
    </div>
  )
}

/** The Staking Details card while its pools and stakers first load. */
function StakingDetailsSkeleton() {
  return (
    <Card aria-busy>
      <CardHeader>
        <CardTitle as="h2" className="flex items-start justify-between gap-x-2">
          Staking Details
          <Skeleton className="-my-2.5 h-9 w-[120px]" />
        </CardTitle>
      </CardHeader>
      <CardContent className="mt-2.5 mb-4 space-y-6">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="self-start py-2 flex items-center justify-center">
            {/* Tremor's donut, ring and all */}
            <div className="w-52 h-52 sm:w-64 sm:h-64 animate-pulse rounded-full border-[1.75rem] border-muted" />
          </div>
          <div className="flex items-center">
            <StakingPoolInfoSkeleton />
          </div>
        </div>
        {/* The stakers list, at its height for a pool with 10 stakers or more */}
        <Skeleton className="h-64 sm:h-96 rounded-lg" />
      </CardContent>
    </Card>
  )
}

/** The whole page's sections while the validator first loads. */
export function ValidatorDetailsSkeleton() {
  return (
    <ValidatorDetailsLayout
      highlights={<Highlights />}
      details={<DetailsSkeleton />}
      staking={<StakingDetailsSkeleton />}
      history={<TotalsHistorySkeleton title="History" stacked />}
      timeline={<ValidatorTimelineSkeleton />}
    />
  )
}
