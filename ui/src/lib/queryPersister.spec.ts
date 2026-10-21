import { QueryClient } from '@tanstack/react-query'
import {
  Persister,
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client'
import type { MockInstance } from 'vitest'
import {
  createQueryCachePersister,
  PERSISTED_GC_TIME,
  persistOptions,
  subscribeQueryCachePersistence,
} from '@/lib/queryPersister'
import { roundKey } from '@/utils/round'

const persister = createQueryCachePersister()

const BUSTER = 'test-buster'

/** Writes are queued behind a timer even at zero delay. */
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 0))

async function save(queryClient: QueryClient, buster = BUSTER) {
  await persistQueryClientSave({
    queryClient,
    persister,
    buster,
    dehydrateOptions: persistOptions.dehydrateOptions,
  })
  await flushWrites()
}

async function restore(buster = BUSTER) {
  const queryClient = new QueryClient()
  await persistQueryClientRestore({
    queryClient,
    persister,
    buster,
    maxAge: persistOptions.maxAge,
    hydrateOptions: persistOptions.hydrateOptions,
  })
  return queryClient
}

describe('query cache persister', () => {
  beforeEach(async () => {
    await persister.removeClient()
  })

  it('round trips bigints without narrowing them', async () => {
    const metrics = {
      // Larger than Number.MAX_SAFE_INTEGER: a JSON codec would lose the last digit
      rewardsBalance: 9007199254740993n,
      roundsSinceLastPayout: 42n,
      apy: 4.25,
      extDeposits: 0,
    }

    const source = new QueryClient()
    source.setQueryData(['validator-metrics', '1', 'latest'], metrics)
    await save(source)

    const restored = await restore()
    const data = restored.getQueryData<typeof metrics>(['validator-metrics', '1', 'latest'])

    expect(typeof data?.rewardsBalance).toBe('bigint')
    expect(data).toEqual(metrics)
  })

  it('round trips the nested bigints in validator core data', async () => {
    const validators = [
      {
        id: 1,
        state: { totalAlgoStaked: 12_345_678_901_234n },
        pools: [{ poolId: 1n, poolAppId: 1234n, totalStakers: 3, totalAlgoStaked: 500n }],
      },
    ]

    const source = new QueryClient()
    source.setQueryData(['all-validators'], validators)
    await save(source)

    const restored = await restore()

    expect(restored.getQueryData(['all-validators'])).toEqual(validators)
  })

  it('round trips a Map keyed by bigint', async () => {
    const poolGlobalStates = new Map([
      [1010n, { lastPayout: 1000n, algodVer: '3.23.1' }],
      [1011n, { algodVer: '3.23.1' }],
    ])

    const source = new QueryClient()
    source.setQueryData(['pool-global-states'], poolGlobalStates)
    await save(source)

    const restored = await restore()
    const data = restored.getQueryData<typeof poolGlobalStates>(['pool-global-states'])

    expect(data).toBeInstanceOf(Map)
    expect(data?.get(1010n)).toEqual({ lastPayout: 1000n, algodVer: '3.23.1' })
  })

  it('persists only allowlisted query keys', async () => {
    const source = new QueryClient()
    source.setQueryData(['all-validators'], ['kept'])
    source.setQueryData(['nfd', 'reti.algo'], { name: 'reti.algo' })
    source.setQueryData(['account-balance', 'ADDR'], 1000n)
    source.setQueryData(['stakes', { staker: 'ADDR' }], ['dropped'])
    await save(source)

    const restored = await restore()

    expect(restored.getQueryData(['all-validators'])).toEqual(['kept'])
    expect(restored.getQueryData(['nfd', 'reti.algo'])).toEqual({ name: 'reti.algo' })
    expect(restored.getQueryData(['account-balance', 'ADDR'])).toBeUndefined()
    expect(restored.getQueryData(['stakes', { staker: 'ADDR' }])).toBeUndefined()
  })

  it('persists the latest state but not reads pinned to a past round', async () => {
    const source = new QueryClient()
    source.setQueryData(['all-validators', roundKey(undefined)], ['latest'])
    source.setQueryData(['all-validators', roundKey(50_000_000n)], ['past'])
    await save(source)

    const restored = await restore()

    expect(restored.getQueryData(['all-validators', roundKey(undefined)])).toEqual(['latest'])
    expect(restored.getQueryData(['all-validators', roundKey(50_000_000n)])).toBeUndefined()
  })

  it('discards a cache written by a different app version', async () => {
    const source = new QueryClient()
    source.setQueryData(['all-validators'], ['stale-shape'])
    await save(source, 'v1')

    const restored = await restore('v2')

    expect(restored.getQueryData(['all-validators'])).toBeUndefined()
    expect(await persister.restoreClient()).toBeUndefined()
  })

  it('keeps restored queries for the persisted gcTime, not the 5 minute default', async () => {
    const source = new QueryClient()
    source.setQueryData(['all-validators', roundKey(undefined)], ['latest'])
    await save(source)

    const restored = await restore()
    const query = restored.getQueryCache().find({ queryKey: ['all-validators', 'latest'] })

    expect(query?.gcTime).toBe(PERSISTED_GC_TIME)
  })
})

describe('subscribeQueryCachePersistence', () => {
  const WAIT = 20
  const settle = () => new Promise((resolve) => setTimeout(resolve, WAIT * 3))

  let persistClient: MockInstance<Persister['persistClient']>
  beforeEach(() => {
    persistClient = vi.spyOn(persistOptions.persister, 'persistClient')
  })
  afterEach(() => {
    persistClient.mockRestore()
  })

  it('coalesces a burst of persisted changes into one save', async () => {
    const queryClient = new QueryClient()
    const unsubscribe = subscribeQueryCachePersistence(queryClient, WAIT)
    for (let id = 1; id <= 20; id++) {
      queryClient.setQueryData(['validator-metrics', String(id), roundKey(undefined)], { id })
    }
    await settle()
    unsubscribe()

    expect(persistClient).toHaveBeenCalledTimes(1)
  })

  it('never saves for reads pinned to a past round or keys that are not persisted', async () => {
    const queryClient = new QueryClient()
    const unsubscribe = subscribeQueryCachePersistence(queryClient, WAIT)
    queryClient.setQueryData(['all-validators', roundKey(50_000_000n)], ['past'])
    queryClient.setQueryData(['account-balance', 'ADDR'], 1000n)
    await settle()
    unsubscribe()

    expect(persistClient).not.toHaveBeenCalled()
  })
})
