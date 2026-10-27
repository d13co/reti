import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import {
  SendRewardTokensDropdownItem,
  SimulateEpochDropdownItem,
} from '@/components/DevDropdownItems'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { StakerValidatorData } from '@/interfaces/staking'
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

interface ValidatorActionsCellProps {
  validator: Validator
  constraints: Constraints
  /** From `useWriteAddress`: null while time travelling, which disables every write */
  writeAddress: string | null
  stakesByValidator: StakerValidatorData[]
}

/**
 * A validator table row's stake button and actions menu. Everything shared comes in as props
 * from the table, so rows don't each subscribe to the wallet or the stakes query.
 */
export function ValidatorActionsCell({
  validator,
  constraints,
  writeAddress,
  stakesByValidator,
}: ValidatorActionsCellProps) {
  const { openAddStake, openUnstake, openAddPool } = useValidatorModals()

  const firstPoolFull = isFirstPoolFull(validator, constraints)
  const stakingDisabled = isStakingDisabled(writeAddress, validator, constraints)
  const unstakingDisabled = isUnstakingDisabled(writeAddress, validator, stakesByValidator)
  const addingPoolDisabled = isAddingPoolDisabled(writeAddress, validator, constraints)
  const canManage = canManageValidator(writeAddress, validator)

  const isDevelopment = process.env.NODE_ENV === 'development'
  const hasRewardToken = validator.config.rewardTokenId > 0
  const canSendRewardTokens = isDevelopment && canManage && hasRewardToken
  const sendRewardTokensDisabled = validator.state.numPools === 0

  const stakerPoolData = stakesByValidator.find(
    (data) => data.validatorId === BigInt(validator.id),
  )?.pools
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
          {!!writeAddress && (
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

                {canSimulateEpoch && stakerPoolData && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <SimulateEpochDropdownItem
                        validator={validator}
                        pools={stakerPoolData}
                        writeAddress={writeAddress}
                        disabled={unstakingDisabled}
                      />
                    </DropdownMenuGroup>
                  </>
                )}

                {canSendRewardTokens && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <SendRewardTokensDropdownItem
                        validator={validator}
                        writeAddress={writeAddress}
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
