import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'

const wallet = vi.hoisted(() => ({ activeAddress: null as string | null }))
vi.mock('@txnlab/use-wallet-react', () => ({ useWallet: () => wallet }))
vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())
vi.mock('@/hooks/useAtRound', async () => (await import('@/utils/tests/sdk')).mockAtRoundModule())

import { stakesQueryOptions } from '@/api/queries'
import { useOwnStakesFirst } from '@/hooks/useOwnStakesFirst'

const STAKER = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

const wrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

describe('useOwnStakesFirst', () => {
  it('lets everything load without a wallet', () => {
    wallet.activeAddress = null
    const { result } = renderHook(() => useOwnStakesFirst(), {
      wrapper: wrapper(new QueryClient()),
    })
    expect(result.current).toBe(true)
  })

  it("holds the rest back while the account's stakes load, then lets it go", async () => {
    wallet.activeAddress = STAKER
    const queryClient = new QueryClient()
    let finish: (value: []) => void = () => {}
    const loading = queryClient.prefetchQuery({
      ...stakesQueryOptions(STAKER),
      queryFn: () => new Promise<[]>((resolve) => (finish = resolve)),
    })
    const { result, rerender } = renderHook(() => useOwnStakesFirst(), {
      wrapper: wrapper(queryClient),
    })
    expect(result.current).toBe(false)

    finish([])
    await loading
    rerender()
    expect(result.current).toBe(true)
  })

  it("doesn't start the stakes read, nor wait for one nobody started", () => {
    wallet.activeAddress = STAKER
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useOwnStakesFirst(), { wrapper: wrapper(queryClient) })
    expect(result.current).toBe(true)
    expect(queryClient.getQueryState(stakesQueryOptions(STAKER).queryKey)?.fetchStatus).not.toBe(
      'fetching',
    )
  })
})
