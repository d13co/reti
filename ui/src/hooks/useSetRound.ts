import { useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import type { RootSearch } from '@/routes/__root'

/**
 * Moves the whole app to `round` (time travel), or back to the latest state when undefined. Stays
 * on the current page; the root route's `retainSearchParams` keeps the round on every link after.
 */
export function useSetRound(): (round: bigint | undefined) => Promise<void> {
  const navigate = useNavigate()
  return React.useCallback(
    (round: bigint | undefined) =>
      navigate({
        to: '.',
        search: (prev: RootSearch) => ({
          ...prev,
          round: round === undefined ? undefined : Number(round),
        }),
      }),
    [navigate],
  )
}
