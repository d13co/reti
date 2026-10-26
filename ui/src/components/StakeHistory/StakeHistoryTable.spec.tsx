import { fireEvent, render, screen, within } from '@testing-library/react'
import * as React from 'react'
import type { StakeEvent } from 'reti-ghost-sdk'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: React.forwardRef<
    HTMLAnchorElement,
    { to: string; params?: Record<string, string>; children?: React.ReactNode }
  >(function Link({ to, params, children, ...rest }, ref) {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    )
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    )
  }),
}))
vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())

import { StakeHistoryTable } from '@/components/StakeHistory/StakeHistoryTable'

const base = { validatorId: 7n, poolId: 2n, poolAppId: 1010n, timestamp: 1_700_000_000 }

const EVENTS: StakeEvent[] = [
  {
    ...base,
    round: 300n,
    kind: 'withdrawal',
    amount: 6_000_000n,
    balanceAfter: 0n,
    left: true,
    approximate: true,
  },
  { ...base, round: 200n, kind: 'mixed', amount: 0n, balanceAfter: 6_000_000n },
  {
    ...base,
    round: 100n,
    kind: 'deposit',
    amount: 5_000_000n,
    balanceAfter: 5_000_000n,
    joined: true,
  },
]

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row')

describe('StakeHistoryTable', () => {
  it('shows each event with its validator, pool, type, amount and round', () => {
    render(<StakeHistoryTable events={EVENTS} showValidator />)
    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Date',
      'Validator',
      'Pool',
      'Type',
      'Amount',
      'Balance After',
      'Round',
    ])

    const [withdrawal, mixed, deposit] = rows
    expect(withdrawal).toHaveTextContent('Withdrawal')
    expect(withdrawal).toHaveTextContent('left')
    expect(withdrawal).toHaveTextContent('Pool 2')
    expect(within(withdrawal).getByRole('link', { name: 'Validator 7' })).toHaveAttribute(
      'href',
      '/validators/7',
    )
    expect(within(withdrawal).getByLabelText('Info: Approximate amount')).toBeInTheDocument()
    expect(mixed).toHaveTextContent('Mixed')
    expect(deposit).toHaveTextContent('Deposit')
    expect(deposit).toHaveTextContent('joined')
    expect(deposit.textContent).toMatch(/\+A5/)
  })

  it('opens the app at an event round', () => {
    render(<StakeHistoryTable events={EVENTS} />)
    fireEvent.click(screen.getByRole('button', { name: '300' }))
    expect(navigate).toHaveBeenCalledTimes(1)
    const { search } = navigate.mock.calls[0][0]
    expect(search({})).toEqual({ round: 300 })
  })

  it('leaves out the validator and the balance when compact', () => {
    render(<StakeHistoryTable events={EVENTS} compact />)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Date',
      'Pool',
      'Type',
      'Amount',
      'Round',
    ])
  })

  it('draws skeleton rows while more events may arrive', () => {
    render(<StakeHistoryTable events={EVENTS.slice(0, 1)} loadingRows={2} />)
    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.getAttribute('aria-busy') === 'true')).toHaveLength(2)
  })

  it('says when there is nothing to show', () => {
    render(<StakeHistoryTable events={[]} />)
    expect(screen.getByText('No deposits or withdrawals.')).toBeInTheDocument()
  })
})
