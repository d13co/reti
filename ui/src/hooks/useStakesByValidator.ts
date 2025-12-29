import { stakesQueryOptions } from '@/api/queries'
import { StakerValidatorData } from '@/interfaces/staking'
import { useQuery } from '@tanstack/react-query'
import React from 'react'

export function useStakesByValidator(activeAddress: string | null): StakerValidatorData[] {
  const stakesQuery = useQuery(stakesQueryOptions(activeAddress))
  const stakesByValidator = React.useMemo(() => stakesQuery.data || [], [stakesQuery.data])
  return stakesByValidator
}
