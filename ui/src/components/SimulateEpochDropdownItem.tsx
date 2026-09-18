import { StakerPoolData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'
import { simulateEpoch } from '@/utils/development'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { FlaskConical } from 'lucide-react'
import { DropdownMenuItem } from './ui/dropdown-menu'

export function SimulateEpochDropdownItem({
  validator,
  unstakingDisabled,
  pools,
}: {
  validator: Validator
  unstakingDisabled: boolean
  pools: StakerPoolData[]
}) {
  const { transactionSigner, activeAddress } = useWallet()
  const router = useRouter()
  const queryClient = useQueryClient()

  return activeAddress ? (
    <DropdownMenuItem
      onClick={async () => {
        await simulateEpoch(
          validator,
          pools,
          100,
          transactionSigner,
          activeAddress,
          queryClient,
          router,
        )
      }}
      disabled={unstakingDisabled}
    >
      <FlaskConical className="h-4 w-4 mr-2 text-muted-foreground" />
      Simulate Epoch
    </DropdownMenuItem>
  ) : null
}
