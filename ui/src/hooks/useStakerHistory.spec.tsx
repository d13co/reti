import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'

const support = vi.hoisted(() => ({ supported: false }))

vi.mock('@/api/reti', async () => ({
  ...(await import('@/utils/tests/sdk')).mockRetiModule(),
  timeTravelSupportQueryOptions: {
    queryKey: ['time-travel-support'],
    queryFn: async () => ({ supported: support.supported }),
  },
}))
vi.mock('@/hooks/useAtRound', async () => (await import('@/utils/tests/sdk')).mockAtRoundModule())

import { useStakerHistory, useStakerPools } from '@/hooks/useStakerHistory'
import { mockSdk } from '@/utils/tests/sdk'

const STAKER = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useStakerHistory', () => {
  beforeEach(() => {
    mockSdk.getStakerHistory.mockClear()
    mockSdk.getStakerPools.mockClear()
  })

  it('reads nothing on a node without time travel', async () => {
    support.supported = false
    const { result } = renderHook(() => useStakerHistory(STAKER), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(result.current.query.fetchStatus).toBe('idle')
    expect(mockSdk.getStakerHistory).not.toHaveBeenCalled()
  })

  it('reads the history once the node has time travel', async () => {
    support.supported = true
    const { result } = renderHook(() => useStakerHistory(STAKER, 7), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.query.data?.complete).toBe(true))
    expect(mockSdk.getStakerHistory).toHaveBeenCalledWith(
      STAKER,
      expect.objectContaining({ validatorId: 7 }),
    )
  })

  it('reads nothing without an address', async () => {
    support.supported = true
    const { result } = renderHook(() => useStakerHistory(null), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.supported).toBe(true))
    expect(result.current.query.fetchStatus).toBe('idle')
    expect(mockSdk.getStakerHistory).not.toHaveBeenCalled()
  })

  it('gates the pools the same way', async () => {
    support.supported = false
    const { result } = renderHook(() => useStakerPools(STAKER), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(mockSdk.getStakerPools).not.toHaveBeenCalled()
  })
})
