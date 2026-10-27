import * as React from 'react'
import { AddPoolModal } from '@/components/AddPoolModal'
import { AddStakeModal } from '@/components/AddStakeModal'
import { UnstakeModal } from '@/components/UnstakeModal'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { StakerValidatorData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'

export interface ValidatorModals {
  openAddStake: (validator: Validator) => void
  openUnstake: (validator: Validator) => void
  openAddPool: (validator: Validator) => void
}

/** Exported for tests, which can supply openers without mounting the modals */
export const ValidatorModalsContext = React.createContext<ValidatorModals | null>(null)

interface ValidatorModalsProviderProps {
  stakesByValidator: StakerValidatorData[]
  constraints: Constraints
  children: React.ReactNode
}

/**
 * One set of stake / unstake / add pool modals for every table on the page. The openers are
 * stable, so table cells can call them without the columns depending on modal state.
 */
export function ValidatorModalsProvider({
  stakesByValidator,
  constraints,
  children,
}: ValidatorModalsProviderProps) {
  const [addStakeValidator, setAddStakeValidator] = React.useState<Validator | null>(null)
  const [unstakeValidator, setUnstakeValidator] = React.useState<Validator | null>(null)
  const [addPoolValidator, setAddPoolValidator] = React.useState<Validator | null>(null)

  const modals = React.useMemo<ValidatorModals>(
    () => ({
      openAddStake: setAddStakeValidator,
      openUnstake: setUnstakeValidator,
      openAddPool: setAddPoolValidator,
    }),
    [],
  )

  return (
    <ValidatorModalsContext.Provider value={modals}>
      {children}
      <Modals
        addStakeValidator={addStakeValidator}
        setAddStakeValidator={setAddStakeValidator}
        unstakeValidator={unstakeValidator}
        setUnstakeValidator={setUnstakeValidator}
        addPoolValidator={addPoolValidator}
        setAddPoolValidator={setAddPoolValidator}
        stakesByValidator={stakesByValidator}
        constraints={constraints}
      />
    </ValidatorModalsContext.Provider>
  )
}

interface ModalsProps {
  addStakeValidator: Validator | null
  setAddStakeValidator: React.Dispatch<React.SetStateAction<Validator | null>>
  unstakeValidator: Validator | null
  setUnstakeValidator: React.Dispatch<React.SetStateAction<Validator | null>>
  addPoolValidator: Validator | null
  setAddPoolValidator: React.Dispatch<React.SetStateAction<Validator | null>>
  stakesByValidator: StakerValidatorData[]
  constraints: Constraints
}

/**
 * Memoized: the provider re-renders with the dashboard for every batch of data, and the modals,
 * closed or open, only need to when their own props change.
 */
const Modals = React.memo(function Modals({
  addStakeValidator,
  setAddStakeValidator,
  unstakeValidator,
  setUnstakeValidator,
  addPoolValidator,
  setAddPoolValidator,
  stakesByValidator,
  constraints,
}: ModalsProps) {
  return (
    <>
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
    </>
  )
})

export function useValidatorModals(): ValidatorModals {
  const modals = React.useContext(ValidatorModalsContext)
  if (!modals) {
    throw new Error('useValidatorModals must be used within ValidatorModalsProvider')
  }
  return modals
}
