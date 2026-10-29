import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { poolAlgodChangesQueryOptions } from '@/api/upgrades'
import { CHANGE_SPAN_ROUNDS } from '@/utils/upgrades'

const reti = vi.hoisted(() => ({
  latest: 0n,
  getPoolAlgodVersionChanges: vi.fn(),
}))

vi.mock('@/api/reti', () => ({
  readAlgorand: undefined,
  latestReadRound: vi.fn(async () => reti.latest),
  retiSdk: { getPoolAlgodVersionChanges: reti.getPoolAlgodVersionChanges },
}))

const POOL = 1010n
const START = CHANGE_SPAN_ROUNDS
const END = START + CHANGE_SPAN_ROUNDS - 1n

const change = (round: bigint, algodVer: string) => ({ round, timestamp: Number(round), algodVer })

describe('poolAlgodChangesQueryOptions', () => {
  let queryClient: QueryClient
  const fetch = () => queryClient.fetchQuery(poolAlgodChangesQueryOptions(queryClient, POOL, START))

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    reti.getPoolAlgodVersionChanges.mockReset()
  })

  it('scans an open span up to the latest round, then on from where it got to', async () => {
    reti.latest = START + 100n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(START + 10n, 'a')])
    expect(await fetch()).toEqual({ to: START + 100n, changes: [change(START + 10n, 'a')] })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: START,
      maxRound: START + 100n,
      signal: expect.anything(),
    })

    reti.latest = START + 200n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([change(START + 150n, 'b')])
    const extended = await queryClient.fetchQuery({
      ...poolAlgodChangesQueryOptions(queryClient, POOL, START),
      staleTime: 0,
    })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: START + 101n,
      maxRound: START + 200n,
      signal: expect.anything(),
    })
    expect(extended).toEqual({
      to: START + 200n,
      changes: [change(START + 10n, 'a'), change(START + 150n, 'b')],
    })
  })

  it('stops at the end of the span and keeps a closed span for good', async () => {
    reti.latest = END + 5_000n
    reti.getPoolAlgodVersionChanges.mockResolvedValueOnce([])
    expect(await fetch()).toEqual({ to: END, changes: [] })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenLastCalledWith(POOL, {
      minRound: START,
      maxRound: END,
      signal: expect.anything(),
    })
    const query = queryClient.getQueryCache().find({
      queryKey: poolAlgodChangesQueryOptions(queryClient, POOL, START).queryKey,
    })!
    expect(query.isStale()).toBe(false)
    await queryClient.fetchQuery({
      ...poolAlgodChangesQueryOptions(queryClient, POOL, START),
      staleTime: 0,
    })
    expect(reti.getPoolAlgodVersionChanges).toHaveBeenCalledTimes(1)
  })

  it("reads nothing for a span the chain hasn't reached", async () => {
    reti.latest = START - 1n
    expect(await fetch()).toEqual({ to: START - 1n, changes: [] })
    expect(reti.getPoolAlgodVersionChanges).not.toHaveBeenCalled()
  })
})
