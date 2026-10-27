import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import * as React from 'react'
import type { Constraints } from '@/contracts/ValidatorRegistryClient'
import type { StakerValidatorData } from '@/interfaces/staking'
import type { Validator } from '@/interfaces/validator'

const ADDRESS = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouter: () => ({}),
}))
vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => ({ activeAddress: ADDRESS, transactionSigner: vi.fn() }),
}))
vi.mock('@/hooks/useAtRound', () => ({
  useViewedTime: () => undefined,
  useWriteAddress: () => null,
}))
vi.mock('@/components/NfdDisplay', () => ({ NfdDisplay: () => null }))

import { StakingTable } from '@/components/StakingTable'
import { ValidatorModals, ValidatorModalsContext } from '@/providers/ValidatorModalsProvider'

const TOKEN = { index: 77n, params: { decimals: 2, unitName: 'TKN' } }

function validator(id: number, rewardToken?: typeof TOKEN): Validator {
  return {
    id,
    config: { owner: ADDRESS, nfdForInfo: 0n, sunsettingOn: 0n, epochRoundLength: 100n },
    rewardToken,
  } as unknown as Validator
}

function stake(
  validatorId: number,
  balance: bigint,
  totalRewarded: bigint,
  rewardTokenBalance = 0n,
): StakerValidatorData {
  return {
    validatorId: BigInt(validatorId),
    balance,
    totalRewarded,
    rewardTokenBalance,
    entryRound: 0n,
    lastPayout: 0n,
    pools: [],
  }
}

/** The table only opens modals on click; these tests don't */
const NO_MODALS: ValidatorModals = {
  openAddStake: () => {},
  openUnstake: () => {},
  openAddPool: () => {},
}

function renderTable(stakes: StakerValidatorData[]) {
  const validators = [validator(1), validator(2, TOKEN), validator(3, TOKEN)]
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ValidatorModalsContext.Provider value={NO_MODALS}>
        <StakingTable
          validators={validators}
          stakesByValidator={stakes}
          isLoading={false}
          constraints={{} as Constraints}
        />
      </ValidatorModalsContext.Provider>
    </QueryClientProvider>,
  )
}

/** The table's footer (`tfoot`), if it has one */
const footer = () => document.querySelector('tfoot')

describe('StakingTable totals', () => {
  it('totals the balances and rewards of every stake', () => {
    renderTable([
      stake(1, 1_000_000n, 100_000n),
      stake(2, 2_500_000n, 250_000n, 150n),
      stake(3, 500_000n, 50_000n, 25n),
    ])

    const cells = within(footer() as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
    expect(cells[0]).toBe('Total (3 validators)')
    // The ALGO symbol, then AlgoDisplayAmount's usual text
    expect(cells[1]).toBe('A4.') // 1 + 2.5 + 0.5 ALGO
    expect(cells[2]).toBe('A0.4') // 0.1 + 0.25 + 0.05 ALGO
    expect(cells[3]).toBe('') // no reward token total
    // Stake rows are unchanged
    expect(screen.getAllByRole('row')).toHaveLength(1 + 3 + 1)
  })

  it('has no total for a single stake', () => {
    renderTable([stake(1, 1_000_000n, 100_000n)])
    expect(footer()).toBeNull()
  })
})
