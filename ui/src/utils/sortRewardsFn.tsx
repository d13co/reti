import { Validator } from '@/interfaces/validator'
import { SortingFn } from '@tanstack/react-table'

export const sortRewardsFn: SortingFn<Validator> = (rowA, rowB) => {
  const a = rowA.original
  const b = rowB.original

  // Assign values for epoch payout status
  const getStatus = (validator: Validator): number => {
    if (validator.roundsSinceLastPayout === undefined) return 0 // red
    if (validator.roundsSinceLastPayout < 21n) return 2 // green
    if (validator.roundsSinceLastPayout < 1200n) return 1 // yellow
    return 0 // red
  }

  const statusA = getStatus(a)
  const statusB = getStatus(b)

  // Compare status
  if (statusA !== statusB) {
    return statusA - statusB
  }

  // If status is the same, compare rewardsBalance
  if (a.rewardsBalance === undefined && b.rewardsBalance === undefined) return 0
  if (a.rewardsBalance === undefined) return 1
  if (b.rewardsBalance === undefined) return -1

  // Compare rewardsBalance
  return Number(a.rewardsBalance - b.rewardsBalance)
}
