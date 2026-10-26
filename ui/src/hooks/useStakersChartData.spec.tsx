import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())
vi.mock('@/hooks/useAtRound', async () => (await import('@/utils/tests/sdk')).mockAtRoundModule())

import { useStakersChartData } from '@/hooks/useStakersChartData'
import { MOCK_STAKED_INFO_1, MOCK_STAKED_INFO_2 } from '@/utils/tests/fixtures/boxes'

const createWrapper = () => {
  const queryClient = new QueryClient()
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useStakersChartData', () => {
  it('returns correct data', async () => {
    const { result } = renderHook(
      () =>
        useStakersChartData({
          selectedPool: 'all',
          validatorId: 1,
        }),
      {
        wrapper: createWrapper(),
      },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.stakersChartData).toEqual([
      {
        name: MOCK_STAKED_INFO_1.account,
        value: Number(MOCK_STAKED_INFO_1.balance),
        address: MOCK_STAKED_INFO_1.account,
        href: `/history/${MOCK_STAKED_INFO_1.account}`,
        target: '_self',
      },
      {
        name: MOCK_STAKED_INFO_2.account,
        value: Number(MOCK_STAKED_INFO_2.balance),
        address: MOCK_STAKED_INFO_2.account,
        href: `/history/${MOCK_STAKED_INFO_2.account}`,
        target: '_self',
      },
    ])
  })
})

describe('useStakersChartData at a pinned round', () => {
  it('links to the history at that round', async () => {
    vi.resetModules()
    vi.doMock('@/hooks/useAtRound', async () =>
      (await import('@/utils/tests/sdk')).mockAtRoundModule(123n),
    )
    const { useStakersChartData: atRound } = await import('@/hooks/useStakersChartData')
    const { result } = renderHook(() => atRound({ selectedPool: 'all', validatorId: 1 }), {
      wrapper: createWrapper(),
    })
    await waitFor(() => expect(result.current.stakersChartData).toHaveLength(2))
    expect(result.current.stakersChartData[0].href).toBe(
      `/history/${MOCK_STAKED_INFO_1.account}?round=123`,
    )
  })
})
