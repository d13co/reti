import type algosdk from 'algosdk'
import { GatingType } from '@/constants/gating'
import type { Nfd } from '@/interfaces/nfd'
import type { NodelyRetiPerfData } from '@/interfaces/nodely'
import type { ValidatorCoreData } from '@/interfaces/validator'
import { assembleValidators, NO_VALIDATORS, ValidatorEnrichment } from '@/utils/assembleValidators'

function core(id: number, config: Record<string, unknown> = {}): ValidatorCoreData {
  return {
    id,
    config: {
      rewardTokenId: 0n,
      nfdForInfo: 0n,
      entryGatingType: 0,
      entryGatingAssets: [0n, 0n, 0n, 0n],
      ...config,
    },
    state: {},
    pools: [],
    nodePoolAssignment: {},
  } as unknown as ValidatorCoreData
}

const asset = (index: bigint) => ({ index }) as unknown as algosdk.modelsv2.Asset
const nfd = (appID: number, name: string) => ({ appID, name }) as unknown as Nfd

function enrichment(overrides: Partial<ValidatorEnrichment> = {}): ValidatorEnrichment {
  return {
    rewardTokens: [],
    gatingAssets: [],
    nfds: [],
    nfdAppIds: [],
    nfdPending: [],
    nfdSupportPending: false,
    perfRows: undefined,
    metrics: [],
    nodely: [],
    realisedApyById: new Map(),
    pinned: false,
    ...overrides,
  }
}

describe('assembleValidators', () => {
  const data = [core(1, { nfdForInfo: 11n }), core(2, { nfdForInfo: 22n })]

  it('returns the same list and objects when nothing changed', () => {
    const first = assembleValidators(data, enrichment(), NO_VALIDATORS)
    const second = assembleValidators(data, enrichment(), first)
    expect(second.list).toBe(first.list)
  })

  it('rebuilds a validator when its data lands', () => {
    const first = assembleValidators(data, enrichment(), NO_VALIDATORS)
    const second = assembleValidators(
      data,
      enrichment({ nfds: [nfd(22, 'two.algo')], nfdAppIds: [11, 22], nfdPending: [true, false] }),
      first,
    )
    expect(second.list).not.toBe(first.list)
    expect(second.list[1].nfd?.name).toBe('two.algo')
    expect(second.list[1]).not.toBe(first.list[1])
    expect(second.list[0].nfdLoading).toBe(true)
  })

  it('keeps an untouched validator object while another changes', () => {
    const before = enrichment({ nfdAppIds: [11, 22], nfdPending: [true, true] })
    const first = assembleValidators(data, before, NO_VALIDATORS)
    const second = assembleValidators(
      data,
      { ...before, nfds: [nfd(22, 'two.algo')], nfdPending: [true, false] },
      first,
    )
    expect(second.list[0]).toBe(first.list[0])
    expect(second.list[1]).not.toBe(first.list[1])
  })

  it('shows the realised APY, else Nodely, else the on-chain one', () => {
    const metrics = [{ rewardsBalance: 5n, roundsSinceLastPayout: 3n, apy: 4, extDeposits: 1 }]
    const one = [core(1)]
    const apy = (extras: Parameters<typeof enrichment>[0]) =>
      assembleValidators(one, enrichment({ metrics, ...extras }), NO_VALIDATORS).list[0].apy
    expect(apy({})).toBe(4)
    expect(apy({ nodely: [{ apy: 6 }] })).toBe(6)
    expect(apy({ realisedApyById: new Map([[1, 3]]) })).toBe(3)
    expect(apy({ nodely: [{ apy: 6 }], realisedApyById: new Map([[1, 3]]) })).toBe(3)
    // no realised figure for the validator: Nodely's shows
    expect(apy({ nodely: [{ apy: 6 }], realisedApyById: new Map([[1, null]]) })).toBe(6)
  })

  it('picks up reward tokens, gating assets and perf, and drops perf at a past round', () => {
    const one = [
      core(1, {
        rewardTokenId: 7n,
        entryGatingType: GatingType.AssetId,
        entryGatingAssets: [8n, 9n, 0n, 0n],
      }),
    ]
    const perfRows = [{ validatorid: 1, perf: 0.9 }] as unknown as NodelyRetiPerfData[]
    const extras = enrichment({
      rewardTokens: [asset(7n)],
      gatingAssets: [asset(8n), undefined],
      perfRows,
    })
    const live = assembleValidators(one, extras, NO_VALIDATORS).list[0]
    expect(live.rewardToken?.index).toBe(7n)
    expect(live.gatingAssets?.map((a) => a.index)).toEqual([8n])
    expect(live.perf).toBe(0.9)

    const past = assembleValidators(one, { ...extras, pinned: true }, NO_VALIDATORS).list[0]
    expect(past.perf).toBeUndefined()
  })

  it('rebuilds when the core data object changes', () => {
    const first = assembleValidators(data, enrichment(), NO_VALIDATORS)
    const refetched = [data[0], core(2, { nfdForInfo: 22n, percentToValidator: 5n })]
    const second = assembleValidators(refetched, enrichment(), first)
    expect(second.list[0]).toBe(first.list[0])
    expect(second.list[1]).not.toBe(first.list[1])
  })
})
