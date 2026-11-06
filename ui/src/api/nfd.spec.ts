/**
 * The NFD read layer against a fake `NfdGhostSDK`: how each read reaches the SDK, how SDK
 * records reach the app, and what happens where the node can't read NFDs. Each case loads a fresh copy of the module, since it asks
 * the SDK about support once per session.
 */

import type { NfdRecord } from 'nfd-ghost-sdk'

const fake = vi.hoisted(() => ({
  supported: vi.fn<() => Promise<boolean>>(),
  getRecord: vi.fn(),
  resolveName: vi.fn(),
  reverseLookup: vi.fn(),
  getSegmentsFor: vi.fn(),
}))

vi.mock('nfd-ghost-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nfd-ghost-sdk')>()
  return {
    ...actual,
    NfdGhostSDK: vi.fn(() => ({
      supported: fake.supported,
      getRecord: fake.getRecord,
      resolveName: fake.resolveName,
      reverseLookup: fake.reverseLookup,
      getSegmentsFor: fake.getSegmentsFor,
    })),
  }
})

vi.mock('@/api/reti', () => ({ readAlgorand: {} }))

vi.mock('@/utils/network/getNfdConfig', () => ({
  getNfdRegistryAppIdFromViteEnvironment: () => 760937186n,
}))

const ADDRESS = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

const RECORD: NfdRecord = {
  appId: 1013764620n,
  name: 'king.dragonfi.algo',
  version: '3.7',
  major: 3,
  owner: ADDRESS,
  asaId: 1013764633n,
  parentAppId: 1013764500n,
  category: 'common',
  state: 'owned',
  caAlgo: [ADDRESS, 'OTHER'],
  caAlgoCount: 2,
  caAlgo0: [ADDRESS],
  avatar: 'ipfs://avatar',
  bio: 'hello',
  round: 50_000_000n,
}

/** A fresh copy of the module: it asks about support as it loads, so set `supported` first. */
async function load() {
  vi.resetModules()
  return import('@/api/nfd')
}

describe('NFD reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.supported.mockResolvedValue(true)
  })

  it("maps an SDK record to the app's Nfd shape", async () => {
    const { nfdFromRecord } = await load()
    expect(nfdFromRecord(RECORD)).toEqual({
      name: 'king.dragonfi.algo',
      appID: 1013764620,
      asaID: 1013764633,
      owner: ADDRESS,
      parentAppID: 1013764500,
      category: 'common',
      state: 'owned',
      caAlgo: [ADDRESS, 'OTHER'],
      properties: { userDefined: { avatar: 'ipfs://avatar', bio: 'hello' } },
      currentAsOfBlock: 50_000_000,
    })
    expect(nfdFromRecord({ ...RECORD, state: 'expired' }).state).toBe('available')
    expect(nfdFromRecord({ ...RECORD, parentAppId: null }).parentAppID).toBeUndefined()
  })

  it('reads an NFD by app id or name at the round through the SDK', async () => {
    const { fetchNfd } = await load()
    fake.getRecord.mockResolvedValue(RECORD)
    fake.resolveName.mockResolvedValue(RECORD)

    await expect(fetchNfd(1013764620n, { round: 50_000_000n })).resolves.toMatchObject({
      name: 'king.dragonfi.algo',
    })
    expect(fake.getRecord).toHaveBeenCalledWith(1013764620n, {
      round: 50_000_000n,
      signal: undefined,
    })

    await fetchNfd('king.dragonfi.algo')
    expect(fake.resolveName).toHaveBeenCalledWith('king.dragonfi.algo', {
      round: undefined,
      signal: undefined,
    })
  })

  it('says an NFD the SDK has no record of is not found', async () => {
    const { fetchNfd, isNfdNotFoundError } = await load()
    fake.getRecord.mockResolvedValue(null)

    const error = await fetchNfd(5n).catch((error: unknown) => error)
    expect(isNfdNotFoundError(error)).toBe(true)
  })

  it('fails every read where the node does not support NFD reads', async () => {
    fake.supported.mockResolvedValue(false)
    const { fetchNfd, fetchNfdReverseLookup, fetchNfdGatingSegment, isNfdUnavailableError } =
      await load()

    for (const read of [
      fetchNfd(1n),
      fetchNfdReverseLookup(ADDRESS),
      fetchNfdGatingSegment(ADDRESS, 7n),
    ]) {
      expect(isNfdUnavailableError(await read.catch((error: unknown) => error))).toBe(true)
    }
    expect(fake.getRecord).not.toHaveBeenCalled()
    expect(fake.reverseLookup).not.toHaveBeenCalled()
  })

  it('fails a read when the node could not be asked, and asks again on the next', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.supported.mockRejectedValue(new Error('node down'))
    const { fetchNfd } = await load()
    fake.getRecord.mockResolvedValue(RECORD)

    await expect(fetchNfd(1n)).rejects.toThrow('node down')
    fake.supported.mockResolvedValue(true)
    await expect(fetchNfd(1n)).resolves.toMatchObject({ name: 'king.dragonfi.algo' })
  })

  it('asks again a minute after a failed check, and says when it answers', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      fake.supported.mockRejectedValue(new Error('node down'))
      const { onNfdSupportAnsweredAfterFailure } = await load()
      const answered = vi.fn()
      onNfdSupportAnsweredAfterFailure(answered)
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.supported).toHaveBeenCalledTimes(1)

      fake.supported.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fake.supported).toHaveBeenCalledTimes(2)
      expect(answered).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a lookup the node cannot make as unavailable', async () => {
    const { fetchNfdGatingSegment, isNfdUnavailableError } = await load()
    const { NfdQueryUnavailableError } = await import('nfd-ghost-sdk')
    fake.getSegmentsFor.mockRejectedValue(new NfdQueryUnavailableError('no time travel'))

    const error = await fetchNfdGatingSegment(ADDRESS, 7n).catch((error: unknown) => error)
    expect(isNfdUnavailableError(error)).toBe(true)
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(NfdQueryUnavailableError)
  })

  it('keeps a failed SDK read failed', async () => {
    const { fetchNfd } = await load()
    fake.getRecord.mockRejectedValue(new Error('node down'))

    await expect(fetchNfd(1n)).rejects.toThrow('node down')
    await expect(fetchNfd(1n, { round: 40_000_000n })).rejects.toThrow('node down')
  })

  it('reverse looks up the primary NFD at the round, and none before the registry', async () => {
    const { fetchNfdReverseLookup } = await load()
    const { NfdNotDeployedError } = await import('nfd-ghost-sdk')
    fake.reverseLookup.mockResolvedValue(new Map([[ADDRESS, [RECORD, { ...RECORD, name: 'b' }]]]))

    await expect(fetchNfdReverseLookup(ADDRESS, { round: 50_000_000n })).resolves.toMatchObject({
      name: 'king.dragonfi.algo',
    })
    expect(fake.reverseLookup).toHaveBeenCalledWith([ADDRESS], {
      round: 50_000_000n,
      signal: undefined,
    })

    fake.reverseLookup.mockResolvedValue(new Map([[ADDRESS, []]]))
    await expect(fetchNfdReverseLookup(ADDRESS)).resolves.toBeNull()

    fake.reverseLookup.mockRejectedValue(new NfdNotDeployedError(1n, 21_341_747n))
    await expect(fetchNfdReverseLookup(ADDRESS, { round: 1n })).resolves.toBeNull()
  })

  it('gates on the segments and verified addresses the contract checks', async () => {
    const { fetchNfdGatingAddresses, fetchNfdGatingSegment } = await load()
    fake.getRecord.mockResolvedValue(RECORD)
    fake.getSegmentsFor.mockResolvedValue([RECORD])

    // Only `v.caAlgo.0.as`, as the contract reads it
    await expect(fetchNfdGatingAddresses(1013764620n)).resolves.toEqual([ADDRESS])
    await expect(fetchNfdGatingSegment(ADDRESS, 1013764500n)).resolves.toBe(1013764620n)
    expect(fake.getSegmentsFor).toHaveBeenCalledWith(ADDRESS, 1013764500n, expect.any(Object))

    fake.getSegmentsFor.mockResolvedValue([])
    await expect(fetchNfdGatingSegment(ADDRESS, 1013764500n)).resolves.toBe(0n)
  })
})
