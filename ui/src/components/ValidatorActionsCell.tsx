import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMbrAmountsAndProtocolConstraints } from '@/hooks/useMbrAmountsAndProtocolConstraints'
import { useStakesByValidator } from '@/hooks/useStakesByValidator'
import { Validator } from '@/interfaces/validator'
import { useValidatorModals } from '@/providers/ValidatorModalsProvider'
import {
  canManageValidator,
  isAddingPoolDisabled,
  isFirstPoolFull,
  isStakingDisabled,
  isSunsetting,
  isUnstakingDisabled,
} from '@/utils/contracts'
import { Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { MoreHorizontal } from 'lucide-react'
import * as React from 'react'
import { SendRewardsTokensToPoolDropdownItem } from './SendRewardsTokensToPoolDropdownItem'
import { SimulateEpochDropdownItem } from './SimulateEpochDropdownItem'

interface ValidatorActionsCellProps {
  validator: Validator
}

export function ValidatorActionsCell({ validator }: ValidatorActionsCellProps) {
  const { activeAddress } = useWallet()
  const { openAddStake, openUnstake, openAddPool } = useValidatorModals()
  const stakesByValidator = useStakesByValidator(activeAddress)

  const mbrAndConstraints = useMbrAmountsAndProtocolConstraints()
  if (!mbrAndConstraints) return null
  const { constraints } = mbrAndConstraints

  const { firstPoolFull, stakingDisabled, addingPoolDisabled, canManage } = React.useMemo(
    () => ({
      firstPoolFull: isFirstPoolFull(validator, constraints),
      stakingDisabled: isStakingDisabled(activeAddress, validator, constraints),
      addingPoolDisabled: isAddingPoolDisabled(activeAddress, validator, constraints),
      canManage: canManageValidator(activeAddress, validator),
    }),
    [validator, constraints, activeAddress],
  )

  const { unstakingDisabled, stakerValidatorData } = React.useMemo(
    () => ({
      unstakingDisabled: isUnstakingDisabled(activeAddress, validator, stakesByValidator),
      stakerValidatorData: stakesByValidator.find(
        (data) => data.validatorId === BigInt(validator.id),
      ),
    }),
    [activeAddress, validator, stakesByValidator],
  )

  const isDevelopment = process.env.NODE_ENV === 'development'
  const hasRewardToken = validator.config.rewardTokenId > 0
  const canSendRewardTokens = isDevelopment && canManage && hasRewardToken
  const sendRewardTokensDisabled = validator.state.numPools === 0

  const stakerPoolData = stakerValidatorData?.pools
  const canSimulateEpoch = isDevelopment && canManage && !!stakerPoolData

  return (
    <div className="flex items-center justify-end gap-x-2">
      {isSunsetting(validator) && !unstakingDisabled ? (
        <Button size="sm" variant="secondary" onClick={() => openUnstake(validator)}>
          Unstake
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={firstPoolFull || stakingDisabled}
          onClick={() => openAddStake(validator)}
          className="min-w-[70px]"
        >
          {firstPoolFull ? 'Full' : 'Stake'}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {!!activeAddress && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => openAddStake(validator)}
                  disabled={stakingDisabled}
                >
                  Stake
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => openUnstake(validator)}
                  disabled={unstakingDisabled}
                >
                  Unstake
                </DropdownMenuItem>

                {canManage && (
                  <DropdownMenuItem
                    onClick={() => openAddPool(validator)}
                    disabled={addingPoolDisabled}
                  >
                    Add Staking Pool
                  </DropdownMenuItem>
                )}

                {canSimulateEpoch && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <SimulateEpochDropdownItem
                        validator={validator}
                        pools={stakerPoolData!}
                        unstakingDisabled={unstakingDisabled}
                      />
                    </DropdownMenuGroup>
                  </>
                )}

                {canSendRewardTokens && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <SendRewardsTokensToPoolDropdownItem
                        validator={validator}
                        disabled={sendRewardTokensDisabled}
                      />
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link
                to="/validators/$validatorId"
                params={{ validatorId: validator.id.toString() }}
                preload="intent"
              >
                {canManage ? 'Manage' : 'View'}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
