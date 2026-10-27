import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { resetExtrasReady, useExtrasReady } from '@/hooks/useExtrasReady'

/**
 * Renders the gate beside a query per root, each resolving when released. A query marked `extra`
 * is enabled by the gate, as the app's extras are.
 */
function renderGate(queries: { root: string; extra?: boolean }[]) {
  const gates = queries.map(() => {
    let release: () => void = () => {}
    const promise = new Promise<null>((resolve) => (release = () => resolve(null)))
    return { promise, release: () => act(async () => release()) }
  })
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () => {
      const ready = useExtrasReady()
      queries.forEach(({ root, extra }, i) =>
        useQuery({ queryKey: [root], queryFn: () => gates[i].promise, enabled: !extra || ready }),
      )
      return ready
    },
    { wrapper },
  )
  return { result, release: (i: number) => gates[i].release(), queryClient }
}

const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers()
  resetExtrasReady()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useExtrasReady', () => {
  it('waits for the page reads and the charts to finish, then for a quiet spell', async () => {
    const { result, release } = renderGate([
      { root: 'all-validators' },
      { root: 'totals-series' },
      { root: 'nodely-apy', extra: true },
    ])

    await release(0)
    await advance(5_000)
    expect(result.current).toBe(false)

    await release(1)
    // React Query reports the fetch finished on its next tick
    await advance(10)
    await advance(400)
    expect(result.current).toBe(false)
    await advance(200)
    expect(result.current).toBe(true)
  })

  it("doesn't wait on the extras or NFD names", async () => {
    const { result } = renderGate([{ root: 'nfd' }, { root: 'nodely-perf' }])

    await advance(600)
    expect(result.current).toBe(true)
  })

  it('gives up waiting after 20 seconds', async () => {
    const { result } = renderGate([{ root: 'change-rounds' }])

    await advance(19_000)
    expect(result.current).toBe(false)
    await advance(1_100)
    expect(result.current).toBe(true)
  })

  it('stays ready for components mounted later', async () => {
    const first = renderGate([])
    await advance(600)
    expect(first.result.current).toBe(true)

    const second = renderGate([{ root: 'all-validators' }])
    expect(second.result.current).toBe(true)
  })

  it('starts over on reset, while something is watching', async () => {
    const { result, release } = renderGate([{ root: 'all-validators' }])
    await release(0)
    await advance(600)
    expect(result.current).toBe(true)

    await act(async () => resetExtrasReady())
    expect(result.current).toBe(false)
    await advance(600)
    expect(result.current).toBe(true)
  })

  it('scans the cache once per flood of cache events, not once per event', async () => {
    const { queryClient } = renderGate([{ root: 'all-validators' }])
    const findAll = vi.spyOn(queryClient.getQueryCache(), 'findAll')

    // A round's data seeded: hundreds of queries added and updated in one go
    await act(async () => {
      for (let i = 0; i < 500; i++) queryClient.setQueryData(['validator-state', String(i)], i)
    })
    await advance(10)
    expect(findAll).toHaveBeenCalledTimes(1)
  })

  it('stops re-rendering for fetches once ready', async () => {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    let renders = 0
    renderHook(
      () => {
        renders++
        return useExtrasReady()
      },
      { wrapper },
    )
    await advance(600)
    const readyRenders = renders

    await act(async () => {
      await queryClient.fetchQuery({ queryKey: ['all-validators'], queryFn: () => 1 })
    })
    await advance(10)
    expect(renders).toBe(readyRenders)
  })
})
