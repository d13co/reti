/**
 * The NFD read layer against a fake `NfdGhostSDK` and a fake NFD API: which way each read goes,
 * and how SDK records reach the app. Each case loads a fresh copy of the module, since it asks
 * the SDK about support once per session.
 */

import type { NfdRecord } from 'nfd-ghost-sdk'

const fake = vi.hoisted(() => ({
  supported: vi.fn<() => Promise<boolean>>(),
  getRecord: vi.fn(),
  resolveName: vi.fn(),
  reverseLookup: vi.fn(),
  getSegmentsFor: vi.fn(),
  restGet: vi.fn(),
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

vi.mock('@/lib/axiosNfdApi', () => ({ default: { get: fake.restGet } }))

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

const REST_NFD = { name: 'rest.algo', appID: 1, caAlgo: ['REST'] }

/** A fresh copy of the module: it asks about support as it loads, so set `supported` first. */
async function load() {
  vi.resetModules()
  return import('@/api/nfd')
}

describe('NFD reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.supported.mockResolvedValue(true)
    fake.restGet.mockResolvedValue({ data: REST_NFD })
  })

  it('maps an SDK record to the API shape', async () => {
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

    await expect(
      fetchNfd(1013764620n, undefined, undefined, { round: 50_000_000n }),
    ).resolves.toMatchObject({ name: 'king.dragonfi.algo' })
    expect(fake.getRecord).toHaveBeenCalledWith(1013764620n, {
      round: 50_000_000n,
      signal: undefined,
    })

    await fetchNfd('king.dragonfi.algo')
    expect(fake.resolveName).toHaveBeenCalledWith('king.dragonfi.algo', {
      round: undefined,
      signal: undefined,
    })
    expect(fake.restGet).not.toHaveBeenCalled()
  })

  it('says an NFD the SDK has no record of is not found', async () => {
    const { fetchNfd, isNfdNotFoundError } = await load()
    fake.getRecord.mockResolvedValue(null)

    const error = await fetchNfd(5n).catch((error: unknown) => error)
    expect(isNfdNotFoundError(error)).toBe(true)
    expect(fake.restGet).not.toHaveBeenCalled()
  })

  it('uses the API where the node does not support NFD reads', async () => {
    fake.supported.mockResolvedValue(false)
    const { fetchNfd } = await load()

    await expect(fetchNfd(1n, { view: 'brief' })).resolves.toEqual(REST_NFD)
    expect(fake.getRecord).not.toHaveBeenCalled()
    expect(fake.restGet).toHaveBeenCalledWith('/nfd/1', { params: { view: 'brief' } })
  })

  it('falls back to the API when a read at the latest round fails, not at a pinned round', async () => {
    const { fetchNfd } = await load()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.getRecord.mockRejectedValue(new Error('node down'))

    await expect(fetchNfd(1n)).resolves.toEqual(REST_NFD)
    await expect(fetchNfd(1n, undefined, undefined, { round: 40_000_000n })).rejects.toThrow(
      'node down',
    )
  })

  it('reverse looks up the primary NFD at the round, and none before the registry', async () => {
    const { fetchNfdReverseLookup } = await load()
    const { NfdNotDeployedError } = await import('nfd-ghost-sdk')
    fake.reverseLookup.mockResolvedValue(new Map([[ADDRESS, [RECORD, { ...RECORD, name: 'b' }]]]))

    await expect(
      fetchNfdReverseLookup(ADDRESS, undefined, undefined, { round: 50_000_000n }),
    ).resolves.toMatchObject({ name: 'king.dragonfi.algo' })
    expect(fake.reverseLookup).toHaveBeenCalledWith([ADDRESS], {
      round: 50_000_000n,
      signal: undefined,
    })

    fake.reverseLookup.mockResolvedValue(new Map([[ADDRESS, []]]))
    await expect(fetchNfdReverseLookup(ADDRESS)).resolves.toBeNull()

    fake.reverseLookup.mockRejectedValue(new NfdNotDeployedError(1n, 21_341_747n))
    await expect(
      fetchNfdReverseLookup(ADDRESS, undefined, undefined, { round: 1n }),
    ).resolves.toBeNull()
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

  it('gates through the API search where the node does not support NFD reads', async () => {
    fake.supported.mockResolvedValue(false)
    const { fetchNfdGatingSegment } = await load()
    fake.restGet.mockResolvedValue({ data: { nfds: [{ appID: 42 }] } })

    await expect(fetchNfdGatingSegment(ADDRESS, 7n)).resolves.toBe(42n)
    expect(fake.restGet).toHaveBeenCalledWith(
      '/nfd/v2/search',
      expect.objectContaining({
        params: expect.objectContaining({ parentAppID: 7n, owner: ADDRESS }),
      }),
    )
  })
})
