import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  algodHistoriesRestoreQueryOptions,
  poolAlgodChangesQueryKey,
  poolAlgodChangesQueryOptions,
} from '@/api/upgrades'
import { PERSISTED_GC_TIME } from '@/lib/queryPersister'

const reti = vi.hoisted(() => ({
  latest: 0n,
  getPoolAlgodVersionChanges: vi.fn(),
}))

const store = vi.hoisted(() => ({
  saveAlgodHistory: vi.fn(),
  restoreAlgodHistories: vi.fn(),
}))

vi.mock('@/api/reti', () => ({
  readAlgorand: undefined,
  latestReadRound: vi.fn(async () => reti.latest),
  retiSdk: {
    registryAppId: 99n,
    getPoolAlgodVersionChanges: reti.getPoolAlgodVersionChanges,
  },
}))

vi.mock('@/lib/algodHistoryStore', () => store)

const POOL = 1010n

const change = (round: bigint, algodVer: string) => ({ round, timestamp: Number(round), algodVer })

describe('poolAlgodChangesQueryOptions', () => {
  let queryClient: QueryClient
  const options = () => poolAlgodChangesQueryOptions(queryClient, POOL)
  const fetch = () => queryClient.fetchQuery(options())
  const refetch = () => queryClient.fetchQuery({ ...options(), staleTime: 0 })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    reti.getPoolAlgodVersionChanges.mockReset()
    store.saveAlgodHistory.mockReset()
  })

  it("lists a pool's whole history, then on from where it got to, short of the latest", async () => {
    reti.latest = 1_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(10n, 'a')])
    expect(await fetch()).toEqual({ to: 1_000n, changes: [change(10n, 'a')] })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: undefined,
      maxRound: 1_000n,
      signal: expect.anything(),
    })

    reti.latest = 2_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(1_500n, 'b')])
    expect(await refetch()).toEqual({
      to: 2_000n,
      changes: [change(10n, 'a'), change(1_500n, 'b')],
    })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: 1_001n,
      maxRound: 2_000n,
      signal: expect.anything(),
    })
  })

  it('reads nothing when the chain has not moved', async () => {
    reti.latest = 1_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([])
    await fetch()
    expect(await refetch()).toEqual({ to: 1_000n, changes: [] })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenCalledTimes(1)
  })

  it('keeps the same changes when a listing finds nothing new', async () => {
    reti.latest = 1_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(10n, 'a')])
    const first = await fetch()
    reti.latest = 2_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([])
    expect((await refetch()).changes).toBe(first.changes)
  })

  it('offers each listing to the store, which decides what to write', async () => {
    reti.latest = 1_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([])
    await fetch()
    reti.latest = 2_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(1_500n, 'b')])
    await refetch()
    expect(store.saveAlgodHistory).toHaveBeenCalledTimes(2)
    expect(store.saveAlgodHistory).toHaveBeenLastCalledWith(99n, POOL, {
      to: 2_000n,
      changes: [change(1_500n, 'b')],
    })
  })
})

describe('algodHistoriesRestoreQueryOptions', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    reti.getPoolAlgodVersionChanges.mockReset()
    store.restoreAlgodHistories.mockReset()
  })

  it('loads kept histories as of when they were listed, and extends a stale one', async () => {
    const savedAt = Date.now() - 1000 * 60 * 60
    store.restoreAlgodHistories.mockResolvedValueOnce(
      new Map([[POOL, { to: 1_000n, changes: [change(10n, 'a')], savedAt }]]),
    )
    expect(await queryClient.fetchQuery(algodHistoriesRestoreQueryOptions(queryClient))).toBe(1)
    expect(store.restoreAlgodHistories).toHaveBeenCalledWith(99n)
    const query = queryClient.getQueryCache().find({ queryKey: poolAlgodChangesQueryKey(POOL) })!
    expect(query.state.dataUpdatedAt).toBe(savedAt)

    reti.latest = 2_004n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([])
    const history = await queryClient.fetchQuery(poolAlgodChangesQueryOptions(queryClient, POOL))
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: 1_001n,
      maxRound: 2_000n,
      signal: expect.anything(),
    })
    expect(history).toEqual({ to: 2_000n, changes: [change(10n, 'a')] })
  })

  it("keeps a loaded history for the pool query's gcTime, not the default", async () => {
    store.restoreAlgodHistories.mockResolvedValueOnce(
      new Map([[POOL, { to: 1_000n, changes: [], savedAt: Date.now() }]]),
    )
    await queryClient.fetchQuery(algodHistoriesRestoreQueryOptions(queryClient))
    const query = queryClient.getQueryCache().find({ queryKey: poolAlgodChangesQueryKey(POOL) })!
    expect(query.gcTime).toBe(PERSISTED_GC_TIME)
  })

  it('leaves a history already in the cache that reaches as far', async () => {
    queryClient.setQueryData(poolAlgodChangesQueryKey(POOL), { to: 5_000n, changes: [] })
    store.restoreAlgodHistories.mockResolvedValueOnce(
      new Map([[POOL, { to: 1_000n, changes: [change(10n, 'a')], savedAt: 0 }]]),
    )
    expect(await queryClient.fetchQuery(algodHistoriesRestoreQueryOptions(queryClient))).toBe(0)
    expect(queryClient.getQueryData(poolAlgodChangesQueryKey(POOL))).toEqual({
      to: 5_000n,
      changes: [],
    })
  })

  it('carries on without kept histories when storage fails', async () => {
    store.restoreAlgodHistories.mockRejectedValueOnce(new Error('blocked'))
    expect(await queryClient.fetchQuery(algodHistoriesRestoreQueryOptions(queryClient))).toBe(0)
  })

  it('carries on past the timeout, and loads the histories when they come', async () => {
    vi.useFakeTimers()
    try {
      let resolve: (kept: Map<bigint, unknown>) => void = () => {}
      store.restoreAlgodHistories.mockReturnValueOnce(new Promise((r) => (resolve = r)))
      const restoring = queryClient.fetchQuery(algodHistoriesRestoreQueryOptions(queryClient))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await restoring).toBe(0)
      expect(queryClient.getQueryData(poolAlgodChangesQueryKey(POOL))).toBeUndefined()

      resolve(new Map([[POOL, { to: 1_000n, changes: [change(10n, 'a')], savedAt: 0 }]]))
      await vi.advanceTimersByTimeAsync(0)
      expect(queryClient.getQueryData(poolAlgodChangesQueryKey(POOL))).toEqual({
        to: 1_000n,
        changes: [change(10n, 'a')],
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
