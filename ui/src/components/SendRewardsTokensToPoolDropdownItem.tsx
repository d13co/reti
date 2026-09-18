import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Validator } from '@/interfaces/validator'
import { sendRewardTokensToPool } from '@/utils/development'
import { useWallet } from '@txnlab/use-wallet-react'
import { FlaskConical } from 'lucide-react'

export function SendRewardsTokensToPoolDropdownItem({
  validator,
  disabled,
}: {
  validator: Validator
  disabled: boolean
}) {
  const { transactionSigner, activeAddress } = useWallet()
  return (
    <DropdownMenuItem
      onClick={async () => {
        await sendRewardTokensToPool(validator, 5000, transactionSigner, activeAddress!)
      }}
      disabled={disabled}
    >
      <FlaskConical className="h-4 w-4 mr-2 text-muted-foreground" />
      Send Tokens
    </DropdownMenuItem>
  )
}
