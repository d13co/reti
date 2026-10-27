import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { FlaskConical } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { StakerPoolData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'
import { sendRewardTokensToPool, simulateEpoch } from '@/utils/development'

/*
 * Development-only row menu items. They read the wallet themselves: menu items mount only while
 * the menu is open, so table rows don't each carry a wallet subscription for them.
 */

interface SimulateEpochDropdownItemProps {
  validator: Validator
  pools: StakerPoolData[]
  writeAddress: string
  disabled?: boolean
}

export function SimulateEpochDropdownItem({
  validator,
  pools,
  writeAddress,
  disabled,
}: SimulateEpochDropdownItemProps) {
  const { transactionSigner } = useWallet()
  const router = useRouter()
  const queryClient = useQueryClient()

  return (
    <DropdownMenuItem
      onClick={async () => {
        await simulateEpoch(
          validator,
          pools,
          100,
          transactionSigner,
          writeAddress,
          queryClient,
          router,
        )
      }}
      disabled={disabled}
    >
      <FlaskConical className="h-4 w-4 mr-2 text-muted-foreground" />
      Simulate Epoch
    </DropdownMenuItem>
  )
}

interface SendRewardTokensDropdownItemProps {
  validator: Validator
  writeAddress: string
  disabled?: boolean
}

export function SendRewardTokensDropdownItem({
  validator,
  writeAddress,
  disabled,
}: SendRewardTokensDropdownItemProps) {
  const { transactionSigner } = useWallet()

  return (
    <DropdownMenuItem
      onClick={async () => {
        await sendRewardTokensToPool(validator, 5000, transactionSigner, writeAddress)
      }}
      disabled={disabled}
    >
      <FlaskConical className="h-4 w-4 mr-2 text-muted-foreground" />
      Send Tokens
    </DropdownMenuItem>
  )
}
