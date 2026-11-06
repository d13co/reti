import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'

vi.mock('@/api/reti', async () => {
  const { mockRetiModule } = await import('@/utils/tests/sdk')
  return {
    ...mockRetiModule(),
    timeTravelSupportQueryOptions: {
      queryKey: ['time-travel-support'],
      queryFn: async () => ({ supported: true }),
    },
  }
})
vi.mock('@/hooks/useAtRound', async () => (await import('@/utils/tests/sdk')).mockAtRoundModule())
vi.mock('@/hooks/useSetRound', () => ({ useSetRound: () => vi.fn() }))

import { ValidatorTimeline } from '@/components/ValidatorDetails/ValidatorTimeline'
import { dayjs } from '@/utils/dayjs'
import { MOCK_VALIDATOR_1 } from '@/utils/tests/fixtures/validators'
import { mockPoolState, mockSdk, mockValidatorTotals } from '@/utils/tests/sdk'

const ALGO = 1_000_000n

/** Newest first: pool 1 pays out at 300, pool 2 takes a deposit at 200, 100 fails to read. */
const CHANGES = [300n, 200n, 100n].map((round) => ({
  round,
  timestamp: 1_700_000_000 + Number(round),
  deleted: false,
}))

const dateOf = (round: bigint) =>
  dayjs.unix(CHANGES.find((change) => change.round === round)!.timestamp).format('lll')

function renderTimeline() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ValidatorTimeline validator={MOCK_VALIDATOR_1} />
    </QueryClientProvider>,
  )
}

const rowOf = (round: bigint) =>
  screen.getByText(round.toLocaleString()).closest('button') as HTMLElement

describe('ValidatorTimeline', () => {
  const { reader } = mockSdk.ghost

  beforeEach(() => {
    mockSdk.getChangeRounds.mockReset()
    mockSdk.getChangeRounds.mockResolvedValue({ changes: CHANGES })
    mockSdk.ghost.atRounds.mockClear()
    reader.getValidatorTotals.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.validatorIds.map((id) =>
        mockValidatorTotals(id, {
          numPools: 2n,
          totalStakers: round >= 200n ? 5n : 4n,
          totalAlgoStaked:
            20_000n * ALGO +
            (round >= 200n ? 5_000n * ALGO : 0n) +
            (round >= 300n ? 12n * ALGO : 0n),
        }),
      ),
    )
    reader.getPoolStates.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.pools.map((id) => {
        if (id === 1010n && round >= 300n) {
          return mockPoolState(id, {
            staked: 10_012n * ALGO,
            lastPayout: 300n,
            epochNumber: 9n,
          })
        }
        if (id === 1011n && round >= 200n) {
          return mockPoolState(id, { numStakers: 3n, staked: 15_000n * ALGO })
        }
        return mockPoolState(id, { staked: 10_000n * ALGO })
      }),
    )
  })

  it('says what each change did, from one read for the page', async () => {
    // Round 99 can't be read, nor read again: round 100's row stays plain
    const real = mockSdk.ghost.atRounds.getMockImplementation()!
    const failAt99: typeof real = async (rounds, fn, options) =>
      (await real(rounds, fn, options)).map((result) =>
        result.round === 99n
          ? { round: result.round, ok: false as const, error: new Error('no') }
          : result,
      )
    mockSdk.ghost.atRounds.mockImplementationOnce(failAt99).mockImplementationOnce(failAt99)
    renderTimeline()

    expect(await screen.findByText('Pool 1 · Epoch 9 payout · +12 ALGO')).toBeInTheDocument()
    expect(screen.getByText('Pool 2 · +5,000 ALGO · +1 staker')).toBeInTheDocument()
    // The page, then its failed round once more
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(2)
    expect(mockSdk.ghost.atRounds.mock.calls[1][0]).toEqual([99n])

    // Each described row keeps its date beneath; the failed one shows only its date
    expect(within(rowOf(300n)).getByText(dateOf(300n))).toBeInTheDocument()
    expect(rowOf(100n)).toHaveTextContent(new RegExp(`^${dateOf(100n)}100$`))
  })

  it("says once why a page's descriptions failed, and keeps its rows' dates", async () => {
    const unsupported = Object.assign(new Error('refused'), { name: 'DTUnsupportedError' })
    mockSdk.ghost.atRounds.mockRejectedValueOnce(unsupported)
    renderTimeline()
    expect(
      await screen.findByText(
        "Couldn't say what some changes did. The read node doesn't support this.",
      ),
    ).toBeInTheDocument()
    expect(rowOf(200n)).toHaveTextContent(new RegExp(`^${dateOf(200n)}200$`))
  })

  it('shows the rows with their dates while their descriptions load', async () => {
    mockSdk.ghost.atRounds.mockImplementationOnce(() => new Promise(() => {}))
    renderTimeline()
    expect(await screen.findByText(dateOf(200n))).toBeInTheDocument()
    expect(screen.queryByText(/ALGO/)).not.toBeInTheDocument()
    expect(rowOf(200n).querySelector('.animate-pulse')).not.toBeNull()
  })
})
