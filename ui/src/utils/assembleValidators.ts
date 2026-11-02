import algosdk from 'algosdk'
import { createBaseValidator } from '@/api/contracts'
import { GatingType } from '@/constants/gating'
import { Nfd } from '@/interfaces/nfd'
import { NodelyRetiPerfData } from '@/interfaces/nodely'
import { Validator, ValidatorCoreData } from '@/interfaces/validator'

type ValidatorMetrics = Pick<
  Validator,
  'rewardsBalance' | 'roundsSinceLastPayout' | 'apy' | 'extDeposits'
>

/** Everything layered onto the core validator data, as the queries in `useValidators` hold it. */
export interface ValidatorEnrichment {
  /** Loaded reward token assets; unloaded entries are undefined */
  rewardTokens: (algosdk.modelsv2.Asset | undefined)[]
  gatingAssets: (algosdk.modelsv2.Asset | undefined)[]
  nfds: (Nfd | undefined)[]
  /** NFD app ids, aligned with `nfdPending` */
  nfdAppIds: number[]
  nfdPending: boolean[]
  nfdSupportPending: boolean
  perfRows: NodelyRetiPerfData[] | undefined
  /** Aligned with the validator data */
  metrics: (ValidatorMetrics | undefined)[]
  /** Aligned with the validator data */
  nodely: (Pick<ValidatorMetrics, 'apy' | 'extDeposits'> | undefined)[]
  realisedApyById: Map<number, number | null | undefined>
  pinned: boolean
}

interface BuiltValidator {
  /** Everything the validator was built from, compared by reference to decide whether to reuse it */
  inputs: unknown[]
  validator: Validator
}

/** One build's output, handed back to the next build so it can reuse what didn't change. */
export interface AssembledValidators {
  byId: Map<number, BuiltValidator>
  list: Validator[]
}

export const NO_VALIDATORS: AssembledValidators = { byId: new Map(), list: [] }

function sameInputs(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

/** Loaded entries of a positionally aligned results list, keyed for O(1) lookup. */
function byKey<T, K>(items: (T | undefined)[], key: (item: T) => K): Map<K, T> {
  const map = new Map<K, T>()
  for (const item of items) {
    if (item !== undefined && item !== null && !map.has(key(item))) map.set(key(item), item)
  }
  return map
}

/**
 * Combines the core validator data with everything layered onto it. Data lands in many small
 * batches (a few NFDs, a few APYs), and a validator none of a batch touched keeps its previous
 * object; when no validator changed, the previous list itself is returned. Memoized table rows
 * then re-render only for the validators that changed.
 *
 * Pure: the result depends only on the arguments, so reusing a previous build is always safe.
 */
export function assembleValidators(
  validatorData: ValidatorCoreData[],
  enrichment: ValidatorEnrichment,
  previous: AssembledValidators,
): AssembledValidators {
  const rewardTokensById = byKey(enrichment.rewardTokens, (asset) => asset.index)
  const gatingAssetsById = byKey(enrichment.gatingAssets, (asset) => asset.index)
  const nfdsByAppId = byKey(enrichment.nfds, (nfd) => Number(nfd.appID))
  const nfdIndexByAppId = new Map(enrichment.nfdAppIds.map((appId, index) => [appId, index]))
  const perfById = new Map<number, number | undefined>()
  for (const row of enrichment.perfRows ?? []) {
    const validatorId = Number(row.validatorid)
    // The first row for a validator wins, as `findValidatorPerf` in `@/utils/nodely` does
    if (!perfById.has(validatorId)) perfById.set(validatorId, row.perf)
  }

  const byId = new Map<number, BuiltValidator>()
  const result: Validator[] = []
  let changed = previous.list.length !== validatorData.length

  for (let i = 0; i < validatorData.length; i++) {
    const data = validatorData[i]
    const { config } = data

    const rewardToken =
      config.rewardTokenId > 0 ? rewardTokensById.get(config.rewardTokenId) : undefined
    const gatingAssets =
      config.entryGatingType === GatingType.AssetId
        ? config.entryGatingAssets
            .map((assetId) => gatingAssetsById.get(assetId))
            .filter((asset): asset is algosdk.modelsv2.Asset => asset !== undefined)
        : undefined
    const nfdAppId = Number(config.nfdForInfo)
    const nfd = nfdAppId > 0 ? nfdsByAppId.get(nfdAppId) : undefined
    const nfdIndex = nfdIndexByAppId.get(nfdAppId)
    const nfdLoading =
      nfdAppId > 0 && !nfd
        ? enrichment.nfdSupportPending ||
          (nfdIndex !== undefined && !!enrichment.nfdPending[nfdIndex])
        : undefined
    const perf = enrichment.pinned ? undefined : perfById.get(data.id)
    const metrics = enrichment.metrics[i]
    const nodely = metrics ? enrichment.nodely[i] : undefined
    const realised = metrics ? enrichment.realisedApyById.get(data.id) : undefined

    // Every value the build below reads. A value left out here would leave a validator stale.
    const inputs: unknown[] = [
      data,
      rewardToken,
      nfd,
      nfdLoading,
      perf,
      metrics,
      nodely,
      realised,
      gatingAssets === undefined,
      ...(gatingAssets ?? []),
    ]
    const cached = previous.byId.get(data.id)
    let validator: Validator
    if (cached && sameInputs(cached.inputs, inputs)) {
      validator = cached.validator
    } else {
      validator = createBaseValidator(data)
      if (rewardToken) validator.rewardToken = rewardToken
      if (gatingAssets) validator.gatingAssets = gatingAssets
      if (nfd) validator.nfd = nfd
      if (nfdLoading !== undefined) validator.nfdLoading = nfdLoading
      validator.perf = perf
      if (metrics) {
        validator.rewardsBalance = metrics.rewardsBalance
        validator.roundsSinceLastPayout = metrics.roundsSinceLastPayout
        // What stakers earned, then Nodely's (live only), then the on-chain moving average
        validator.apy = realised ?? nodely?.apy ?? metrics.apy
        validator.extDeposits = nodely?.extDeposits ?? metrics.extDeposits
      }
    }

    if (previous.list[i] !== validator) changed = true
    byId.set(data.id, { inputs, validator })
    result.push(validator)
  }

  return { byId, list: changed ? result : previous.list }
}
