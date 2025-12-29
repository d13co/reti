import { AddPoolModal } from '@/components/AddPoolModal'
import { AddStakeModal } from '@/components/AddStakeModal'
import { UnstakeModal } from '@/components/UnstakeModal'
import { useMbrAmountsAndProtocolConstraints } from '@/hooks/useMbrAmountsAndProtocolConstraints'
import { useStakesByValidator } from '@/hooks/useStakesByValidator'
import { Validator } from '@/interfaces/validator'
import { useWallet } from '@txnlab/use-wallet-react'
import * as React from 'react'

interface ValidatorModalsContextValue {
  openAddStake: (validator: Validator) => void
  openUnstake: (validator: Validator) => void
  openAddPool: (validator: Validator) => void
}

const ValidatorModalsContext = React.createContext<ValidatorModalsContextValue | null>(null)

interface ValidatorModalsProviderProps {
  children: React.ReactNode
}

export function ValidatorModalsProvider({ children }: ValidatorModalsProviderProps) {
  const [addStakeValidator, setAddStakeValidator] = React.useState<Validator | null>(null)
  const [unstakeValidator, setUnstakeValidator] = React.useState<Validator | null>(null)
  const [addPoolValidator, setAddPoolValidator] = React.useState<Validator | null>(null)

  const contextValue = React.useMemo<ValidatorModalsContextValue>(
    () => ({
      openAddStake: setAddStakeValidator,
      openUnstake: setUnstakeValidator,
      openAddPool: setAddPoolValidator,
    }),
    [],
  )

  const { activeAddress } = useWallet()
  const stakesByValidator = useStakesByValidator(activeAddress)

  const mbrAndConstraints = useMbrAmountsAndProtocolConstraints()
  if (!mbrAndConstraints) return null
  const { constraints } = mbrAndConstraints

  return (
    <ValidatorModalsContext.Provider value={contextValue}>
      {children}

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
      <AddPoolModal validator={addPoolValidator} setValidator={setAddPoolValidator} />
    </ValidatorModalsContext.Provider>
  )
}

export function useValidatorModals() {
  const context = React.useContext(ValidatorModalsContext)
  if (!context) {
    throw new Error('useValidatorModals must be used within ValidatorModalsProvider')
  }
  return context
}
