import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'

vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())
vi.mock('@/hooks/useAtRound', async () =>
  (await import('@/utils/tests/sdk')).mockAtRoundModule(123n),
)

import { sdkAt } from '@/api/reti'
import { WalletBalance } from '@/components/WalletBalance'
import { mockSdk } from '@/utils/tests/sdk'

const ADDRESS = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

describe('WalletBalance at a pinned round', () => {
  it('shows the historical balance as of that round', async () => {
    mockSdk.getAccountBalances.mockClear()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WalletBalance activeAddress={ADDRESS} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Historical Balance')).toBeInTheDocument()
    expect(screen.getByText('As of round 123')).toBeInTheDocument()
    // 40,000 ALGO less the 0.1 minimum balance
    expect(screen.getByText(/39,999/)).toBeInTheDocument()
    expect(sdkAt).toHaveBeenCalledWith(123n)
    expect(mockSdk.getAccountBalances).toHaveBeenCalledWith([ADDRESS], expect.anything())
  })
})
