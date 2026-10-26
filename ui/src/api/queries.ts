import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { keepPreviousData, QueryClient, queryOptions } from '@tanstack/react-query'
import algosdk from 'algosdk'
import { AxiosError } from 'axios'
import { CacheRequestConfig } from 'axios-cache-interceptor'
import { fetchBalance, fetchBalanceAt, fetchBlockTimes } from '@/api/algod'
import {
  fetchAllValidatorData,
  fetchAssetAt,
  fetchMbrAmounts,
  fetchNodelyPoolApy,
  fetchPoolGlobalStates,
  fetchProtocolConstraints,
  fetchStakedInfoForPool,
  fetchStakerValidatorData,
  fetchValidatorConfig,
  fetchValidatorNodePoolAssignments,
  fetchValidatorPools,
  fetchValidatorState,
  processPoolData,
} from '@/api/contracts'
import { fetchNfd, fetchNfdReverseLookup } from '@/api/nfd'
import { fetchNodely24hPerf } from '@/api/nodely'
import { latestReadRound, timeTravelSupportQueryOptions } from '@/api/reti'
import { Nfd, NfdGetLookupParams, NfdGetNFDParams } from '@/interfaces/nfd'
import { LocalPoolInfo, PoolData, PoolGlobalStates } from '@/interfaces/validator'
import { PERSISTED_GC_TIME } from '@/lib/queryPersister'
import {
  APPROX_ROUNDS_PER_DAY,
  calculateValidatorPoolMetrics,
  epochDays,
  REALISED_APY_DAYS,
  realisedApy,
  seedValidatorCoreQueries,
  weightedPoolApy,
} from '@/utils/contracts'
import { resolveIpfsUrl } from '@/utils/ipfs'
import { untilAborted } from '@/utils/abort'
import { pinnedSignal, roundKey, roundQueryDefaults } from '@/utils/round'

// Every protocol read takes an optional `round`: undefined reads the latest state, a round reads
// the state as of the end of that round (time travel, see `@/hooks/useAtRound`). The round is
// always the last element of the query key, and pinned reads never refetch (`roundQueryDefaults`).

////////////////////////////////////////////////////////////
// Core protocol data queries
////////////////////////////////////////////////////////////

/** How often the whole validator set is re-read. One request, so this can be tight. */
const ALL_VALIDATORS_REFETCH_INTERVAL = 1000 * 30 // 30 seconds

/**
 * Every validator's config, state, pools and node/pool assignments in a single request.
 *
 * Seeding happens inside the queryFn rather than an effect so the per-validator caches are
 * populated before this promise resolves - anything awaiting it sees a consistent world.
 */
export const allValidatorsQueryOptions = (queryClient: QueryClient, round?: bigint) =>
  queryOptions({
    queryKey: ['all-validators', roundKey(round)],
    queryFn: async (context) => {
      const signal = pinnedSignal(round, context)
      const validators = await fetchAllValidatorData(round, signal)
      // A cancelled read seeds nothing
      signal?.throwIfAborted()
      seedValidatorCoreQueries(queryClient, validators, round)
      return validators
    },
    ...roundQueryDefaults(round, {
      staleTime: ALL_VALIDATORS_REFETCH_INTERVAL,
      gcTime: PERSISTED_GC_TIME,
      refetchInterval: ALL_VALIDATORS_REFETCH_INTERVAL,
      refetchIntervalInBackground: false,
    }),
  })

export const mbrQueryOptions = (round?: bigint) =>
  queryOptions({
    queryKey: ['mbr', roundKey(round)],
    queryFn: (context) => fetchMbrAmounts(round, pinnedSignal(round, context)),
    ...roundQueryDefaults(round, { staleTime: Infinity }),
  })

export const constraintsQueryOptions = (round?: bigint) =>
  queryOptions({
    queryKey: ['constraints', roundKey(round)],
    queryFn: (context) => fetchProtocolConstraints(round, pinnedSignal(round, context)),
    ...roundQueryDefaults(round, {
      staleTime: 1000 * 60 * 60, // 1 hour
    }),
  })

////////////////////////////////////////////////////////////
// Validator data queries
////////////////////////////////////////////////////////////

/**
 * Keep seeded per-validator entries around longer than the 5 minute default, so navigating
 * dashboard -> detail -> back -> detail keeps resolving from cache.
 */
const VALIDATOR_GC_TIME = 1000 * 60 * 10 // 10 minutes

export const validatorConfigQueryOptions = (validatorId: number, round?: bigint) =>
  queryOptions({
    queryKey: ['validator-config', String(validatorId), roundKey(round)],
    queryFn: () => fetchValidatorConfig(validatorId, round),
    ...roundQueryDefaults(round, {
      staleTime: Infinity,
      gcTime: VALIDATOR_GC_TIME,
      refetchInterval: 1000 * 60 * 60 * 2, // 2 hours
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    }),
  })

export const validatorStateQueryOptions = (
  validatorId: number,
  round?: bigint,
  refetchInterval = 1000 * 30, // 30 seconds
  refetchOnWindowFocus = true,
) =>
  queryOptions({
    queryKey: ['validator-state', String(validatorId), roundKey(round)],
    queryFn: () => fetchValidatorState(validatorId, round),
    ...roundQueryDefaults(round, {
      gcTime: VALIDATOR_GC_TIME,
      refetchInterval,
      refetchOnWindowFocus,
      refetchOnMount: false,
    }),
  })

export const validatorPoolsQueryOptions = (
  validatorId: number,
  round?: bigint,
  refetchInterval = 1000 * 30, // 30 seconds
  refetchOnWindowFocus = true,
) =>
  queryOptions({
    queryKey: ['validator-pools', String(validatorId), roundKey(round)],
    queryFn: () => fetchValidatorPools(validatorId, round),
    ...roundQueryDefaults(round, {
      gcTime: VALIDATOR_GC_TIME,
      refetchInterval,
      refetchOnWindowFocus,
      refetchOnMount: false,
    }),
  })

export const validatorNodePoolAssignmentsQueryOptions = (
  validatorId: number,
  round?: bigint,
  enabled = true,
) =>
  queryOptions({
    queryKey: ['validator-node-pool-assignments', String(validatorId), roundKey(round)],
    queryFn: () => fetchValidatorNodePoolAssignments(validatorId, round),
    ...roundQueryDefaults(round, {
      staleTime: Infinity,
      gcTime: VALIDATOR_GC_TIME,
      refetchInterval: 1000 * 60 * 60 * 2, // 2 hours
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    }),
    enabled,
  })

/** Metrics and the bulk inputs they read expire together. */
const METRICS_STALE_TIME = 1000 * 60 * 30 // 30 minutes

/** Keep mounted pool details current as node daemons report new versions. */
const POOL_GLOBAL_STATES_REFETCH_INTERVAL = 1000 * 30 // 30 seconds

/**
 * Every pool's global state and balance in one request, shared by every validator's metrics.
 *
 * The pool list comes from the validator set at the same round - normally a cache hit, since
 * everything that shows pools has read it already.
 */
export const poolGlobalStatesQueryOptions = (queryClient: QueryClient, round?: bigint) =>
  queryOptions({
    queryKey: ['pool-global-states', roundKey(round)],
    queryFn: async (context) => {
      const signal = pinnedSignal(round, context)
      // Shared with every other reader of the validator set, so only the wait is cancelled
      const validators = await untilAborted(
        queryClient.ensureQueryData(allValidatorsQueryOptions(queryClient, round)),
        signal,
      )
      const poolAppIds = validators.flatMap((validator) =>
        validator.pools.map((pool) => pool.poolAppId),
      )
      return fetchPoolGlobalStates(poolAppIds, round, signal)
    },
    ...roundQueryDefaults(round, {
      staleTime: METRICS_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchInterval: POOL_GLOBAL_STATES_REFETCH_INTERVAL,
      refetchOnWindowFocus: false,
    }),
  })

/**
 * One validator's pools' global state, for its page: the same read as
 * {@link poolGlobalStatesQueryOptions}, for its own pools instead of every pool. Starts from the
 * bulk read when that is cached at the same round (the dashboard has usually read it).
 *
 * The pools are part of the key: an observer still holding the previous round's pools (as
 * placeholder data) would otherwise cache a read of the wrong pools under this round.
 */
export const validatorPoolStatesQueryOptions = (
  queryClient: QueryClient,
  validatorId: number,
  pools: LocalPoolInfo[],
  round?: bigint,
) => {
  const bulkKey = poolGlobalStatesQueryOptions(queryClient, round).queryKey
  return queryOptions({
    queryKey: [
      'validator-pool-states',
      String(validatorId),
      pools.map((pool) => String(pool.poolAppId)).join(','),
      roundKey(round),
    ],
    queryFn: (context) =>
      fetchPoolGlobalStates(
        pools.map((pool) => pool.poolAppId),
        round,
        pinnedSignal(round, context),
      ),
    initialData: () => {
      const bulk = queryClient.getQueryData(bulkKey)
      if (!bulk || pools.some((pool) => !(String(pool.poolAppId) in bulk))) return undefined
      return Object.fromEntries(
        pools.map((pool) => [String(pool.poolAppId), bulk[String(pool.poolAppId)]]),
      )
    },
    initialDataUpdatedAt: () => queryClient.getQueryState(bulkKey)?.dataUpdatedAt,
    ...roundQueryDefaults(round, {
      staleTime: METRICS_STALE_TIME,
      refetchInterval: POOL_GLOBAL_STATES_REFETCH_INTERVAL,
      refetchOnWindowFocus: false,
    }),
  })
}

export interface ValidatorMetricsInput {
  pools: LocalPoolInfo[]
  totalAlgoStaked: bigint
  epochRoundLength: number
}

/**
 * Per-validator inputs are passed in rather than pulled from the per-validator caches. Reading
 * them via `ensureQueryData` would silently refetch once those entries are garbage collected,
 * which happens as soon as nothing observes them.
 *
 * The bulk pool state is deliberately *not* an input: the query key is the validator id (and
 * round) alone, and every observer of a key writes its own options onto the shared query on every
 * render, so whichever one rendered last supplies the `queryFn` for any fetch it didn't itself
 * initiate (`refetchQueries`, for instance). Reading it from the cache here - a lookup, never a
 * fetch - keeps every observer's options equivalent. If it isn't there, this validator's own
 * pools are read instead.
 */
export const validatorMetricsQueryOptions = (
  validatorId: number,
  queryClient: QueryClient,
  { pools, totalAlgoStaked, epochRoundLength }: ValidatorMetricsInput,
  round?: bigint,
) =>
  queryOptions({
    queryKey: ['validator-metrics', String(validatorId), roundKey(round)],
    queryFn: async (context) => {
      const poolsData = await metricsPoolData(
        queryClient,
        validatorId,
        pools,
        round,
        epochRoundLength,
        pinnedSignal(round, context),
      )
      const currentRound = round ?? (await latestReadRound())

      return calculateValidatorPoolMetrics(
        poolsData,
        totalAlgoStaked,
        BigInt(epochRoundLength),
        currentRound,
      )
    },
    ...roundQueryDefaults(round, {
      staleTime: METRICS_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchOnWindowFocus: false,
      // Left at the default so metrics restored from the persisted cache are refreshed once they
      // pass their staleTime. The queue in useValidators meters that refresh.
    }),
  })

/**
 * The pools a validator's metrics count, from on-chain state: those holding at least 30k ALGO.
 * The pool state is read from the cache, the bulk read's or the validator page's own (see
 * {@link validatorMetricsQueryOptions}); if neither is there, this validator's own pools are
 * read. With the validator's epoch, each pool's APY is corrected for it (`epochAdjustedApy`).
 */
async function metricsPoolData(
  queryClient: QueryClient,
  validatorId: number,
  pools: LocalPoolInfo[],
  round?: bigint,
  epochRoundLength?: number,
  signal?: AbortSignal,
): Promise<PoolData[]> {
  const poolGlobalStates: PoolGlobalStates =
    queryClient.getQueryData(poolGlobalStatesQueryOptions(queryClient, round).queryKey) ??
    queryClient.getQueryData(
      validatorPoolStatesQueryOptions(queryClient, validatorId, pools, round).queryKey,
    ) ??
    (await fetchPoolGlobalStates(
      pools.map((pool) => pool.poolAppId),
      round,
      signal,
    ))

  return pools
    .map((pool) =>
      processPoolData(pool, poolGlobalStates[String(pool.poolAppId)], epochRoundLength),
    )
    .filter((pool) => pool.balance >= AlgoAmount.Algos(30_000).microAlgos)
}

/** Whether any of a validator's pools pays out less than daily, by the bulk pool state. */
export function hasLongEpoch(
  pools: LocalPoolInfo[],
  epochRoundLength: number,
  poolGlobalStates: PoolGlobalStates | undefined,
): boolean {
  return pools.some(
    (pool) =>
      epochDays(epochRoundLength, poolGlobalStates?.[String(pool.poolAppId)]?.roundsPerDay) > 1,
  )
}

/**
 * Live windows start on a multiple of this, so the read at their start stays cached between
 * refreshes rather than moving with every new round.
 */
const REALISED_START_STEP = 10_000n

/**
 * A validator's APY from what its stakers earned over the last {@link REALISED_APY_DAYS} days
 * (or three epochs, if longer), for validators that pay out less than daily: their on-chain
 * moving average reads several times too high, and even corrected (`epochAdjustedApy`) it is
 * rough. Two staker-list reads per such
 * pool, at the round shown and the window's start; the one at the round shown is the Staking
 * Details' own. A pool with no figure (younger than two epochs in the window, or with every
 * staker adding or removing stake in it) keeps its corrected average. Null when no counted pool
 * has a long epoch, or the read node can't read past rounds.
 */
export const realisedApyQueryOptions = (
  validatorId: number,
  queryClient: QueryClient,
  { pools, epochRoundLength }: Pick<ValidatorMetricsInput, 'pools' | 'epochRoundLength'>,
  round?: bigint,
) =>
  queryOptions({
    queryKey: ['realised-apy', String(validatorId), roundKey(round)],
    queryFn: async (context): Promise<number | null> => {
      const signal = pinnedSignal(round, context)
      // The window's start is a past round, which only a node with time travel can read. Asked
      // once per session, so a node without it costs nothing here.
      const support = await queryClient.ensureQueryData(timeTravelSupportQueryOptions)
      if (!support.supported) return null
      const poolsData = await metricsPoolData(
        queryClient,
        validatorId,
        pools,
        round,
        epochRoundLength,
        signal,
      )
      if (!poolsData.some((pool) => epochDays(epochRoundLength, pool.roundsPerDay) > 1)) {
        return null
      }
      const end = round ?? (await latestReadRound())

      const measured = await Promise.all(
        poolsData.map(async (pool): Promise<PoolData> => {
          const days = epochDays(epochRoundLength, pool.roundsPerDay)
          if (days <= 1 || !pool.poolAppId) return pool
          const perDay = pool.roundsPerDay || APPROX_ROUNDS_PER_DAY
          // At least three payouts' worth, for the longest epochs
          const targetDays = Math.max(REALISED_APY_DAYS, 3 * days)
          let start = end - BigInt(Math.ceil(targetDays * Number(perDay)))
          if (round === undefined) start -= start % REALISED_START_STEP
          if (support.creationRound !== undefined && start < support.creationRound) {
            start = support.creationRound
          }
          const windowDays = Number(end - start) / Number(perDay)
          // Fewer than two payouts in the window is too few to go on
          if (windowDays < 2 * days) return pool
          try {
            // Cached reads others share (the Staking Details' own), so only the wait is cancelled
            const [before, after] = await untilAborted(
              Promise.all([
                queryClient.ensureQueryData(stakedInfoQueryOptions(pool.poolAppId, start)),
                queryClient.ensureQueryData(stakedInfoQueryOptions(pool.poolAppId, round)),
              ]),
              signal,
            )
            const apy = realisedApy(before, after, windowDays)
            return apy === undefined ? pool : { ...pool, apy }
          } catch (error) {
            if (signal?.aborted) throw error
            // Say, a node that can't read past rounds: the corrected average stands
            return pool
          }
        }),
      )
      return weightedPoolApy(measured).apy
    },
    ...roundQueryDefaults(round, {
      staleTime: METRICS_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchOnWindowFocus: false,
    }),
  })

/**
 * A validator's APY by Nodely's realtime figures, which also count external deposits, in place
 * of the on-chain moving average its metrics carry. One Nodely request per counted pool, so
 * callers hold it back until the rest of the page has loaded (`useExtrasReady`). Nodely only
 * answers "now": never use it at a pinned round.
 */
export const nodelyApyQueryOptions = (
  validatorId: number,
  queryClient: QueryClient,
  pools: LocalPoolInfo[],
) =>
  queryOptions({
    // Ends in the live round key, so the persister keeps it like the other live entries
    queryKey: ['nodely-apy', String(validatorId), roundKey(undefined)],
    queryFn: async () => {
      const poolsData = await metricsPoolData(queryClient, validatorId, pools)
      const withNodely = await Promise.all(
        poolsData.map(async (pool) => ({
          ...pool,
          ...(await fetchNodelyPoolApy(pool.poolAppId!)),
        })),
      )
      return weightedPoolApy(withNodely)
    },
    staleTime: METRICS_STALE_TIME,
    gcTime: PERSISTED_GC_TIME,
    refetchOnWindowFocus: false,
  })

////////////////////////////////////////////////////////////
// Staking data queries
////////////////////////////////////////////////////////////

export const stakedInfoQueryOptions = (poolAppId: bigint, round?: bigint) =>
  queryOptions({
    queryKey: ['staked-info', poolAppId.toString(), roundKey(round)],
    queryFn: (context) => fetchStakedInfoForPool(poolAppId, round, pinnedSignal(round, context)),
    enabled: !!poolAppId,
    ...roundQueryDefaults(round, {}),
  })

export const stakesQueryOptions = (staker: string | null, round?: bigint) =>
  queryOptions({
    queryKey: ['stakes', { staker }, roundKey(round)],
    queryFn: (context) => fetchStakerValidatorData(staker!, round, pinnedSignal(round, context)),
    enabled: !!staker,
    retry: false,
    ...roundQueryDefaults(round, {
      refetchInterval: 1000 * 60, // 1 minute
    }),
  })

////////////////////////////////////////////////////////////
// NFD queries
////////////////////////////////////////////////////////////

/**
 * NFD records are near-static and the API is rate limited, so they are cached hard: an hour
 * before a refetch is even considered, a day before the entry is dropped. These keys are also
 * persisted to IndexedDB (see `@/lib/queryPersister`), and `axiosNfdApi` keeps its own
 * persisted HTTP cache underneath, so a reload paints names and avatars without a request.
 *
 * NFDs only answer "now", so they carry no round: a time-travelling page shows today's names.
 */
const NFD_STALE_TIME = 1000 * 60 * 60 // 1 hour

/** Applied when a caller has opted out of the HTTP cache, i.e. asked for fresh data. */
const NFD_VOLATILE_STALE_TIME = 1000 * 60 * 5 // 5 minutes

/**
 * Retries are owned by `axiosNfdApi`, which backs off exponentially on 429s. Layering the
 * react-query retry on top would multiply out to dozens of attempts per record.
 */
const nfdRetry = false

export const nfdQueryOptions = (
  nameOrId: string | number | bigint,
  params: NfdGetNFDParams = { view: 'brief' },
  options: CacheRequestConfig = {},
) =>
  queryOptions<Nfd>({
    queryKey: ['nfd', nameOrId.toString(), params],
    queryFn: () => fetchNfd(nameOrId.toString(), params, options),
    enabled: !!nameOrId,
    placeholderData: keepPreviousData,
    staleTime: NFD_STALE_TIME,
    gcTime: PERSISTED_GC_TIME,
    retry: nfdRetry,
    refetchOnWindowFocus: false,
    // Left at the default: a restored record older than an hour is refreshed, and the axios
    // cache underneath usually answers that without a request anyway.
  })

export const nfdLookupQueryOptions = (
  address: string | null,
  params: Omit<NfdGetLookupParams, 'address'> = { view: 'thumbnail' },
  options: CacheRequestConfig = {},
) => {
  // Reverse lookups follow whichever address currently holds the NFD, and a caller passing
  // `cache: false` has said it cares about that. Don't cache those hard behind its back.
  const isNearStatic = options.cache !== false

  return queryOptions<Nfd | null, AxiosError>({
    queryKey: ['nfd-lookup', address, params],
    queryFn: () => fetchNfdReverseLookup(String(address), params, options),
    enabled: !!address,
    staleTime: isNearStatic ? NFD_STALE_TIME : NFD_VOLATILE_STALE_TIME,
    gcTime: PERSISTED_GC_TIME,
    retry: nfdRetry,
    refetchOnWindowFocus: false,
  })
}

////////////////////////////////////////////////////////////
// Asset queries
////////////////////////////////////////////////////////////

/**
 * An asset's params as of `round`. With `queryClient`, the same asset at any round already cached
 * stands in while it loads: its name and unit don't change, and `useQueries` (unlike
 * `keepAcrossRounds`) can't carry data across rounds itself, so stepping through rounds doesn't
 * blank them.
 */
export const assetQueryOptions = (assetId: number, round?: bigint, queryClient?: QueryClient) =>
  queryOptions<algosdk.modelsv2.Asset>({
    queryKey: ['asset', assetId, roundKey(round)],
    queryFn: (context) => fetchAssetAt(assetId, round, pinnedSignal(round, context)),
    enabled: assetId > 0,
    placeholderData: queryClient
      ? () =>
          queryClient
            .getQueriesData<algosdk.modelsv2.Asset>({ queryKey: ['asset', assetId] })
            .find(([, data]) => data !== undefined)?.[1]
      : undefined,
    ...roundQueryDefaults(round, {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    }),
  })

////////////////////////////////////////////////////////////
// Account queries
////////////////////////////////////////////////////////////

/** The connected wallet's spendable balance. Always live: it's what a transaction can spend. */
export const balanceQueryOptions = (address: string | null) =>
  queryOptions({
    queryKey: ['account-balance', address],
    queryFn: () => fetchBalance(address),
    enabled: !!address,
    refetchInterval: 1000 * 30, // Every 30 seconds
  })

/**
 * An account's balance as of the end of a past round, for the account menu while time
 * travelling. A past balance never changes; writes always use the live {@link balanceQueryOptions}.
 */
export const historicalBalanceQueryOptions = (address: string, round: bigint) =>
  queryOptions({
    queryKey: ['historical-balance', address, roundKey(round)],
    queryFn: (context) => fetchBalanceAt(address, round, pinnedSignal(round, context)),
    enabled: !!address,
    ...roundQueryDefaults(round, {}),
  })

////////////////////////////////////////////////////////////
// IPFS queries
////////////////////////////////////////////////////////////

export const ipfsUrlQueryOptions = (ipfsUrl: string) =>
  queryOptions({
    queryKey: ['ipfs-url', ipfsUrl],
    queryFn: () => resolveIpfsUrl(ipfsUrl),
    enabled: ipfsUrl.startsWith('ipfs://'),
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60 * 24, // 24 hours
    retry: (failureCount) => failureCount < 2,
  })

////////////////////////////////////////////////////////////
// Miscellaneous queries
////////////////////////////////////////////////////////////

/** Timestamps of the 10 blocks before `round` (or the latest), for the average block time. */
export const blockTimeQueryOptions = (round?: bigint) =>
  queryOptions({
    queryKey: ['block-times', roundKey(round)],
    queryFn: (context) => fetchBlockTimes(round, undefined, pinnedSignal(round, context)),
    ...roundQueryDefaults(round, {
      staleTime: 1000 * 60 * 30, // 30 mins
    }),
  })

////////////////////////////////////////////////////////////
// Nodely queries
////////////////////////////////////////////////////////////
export const nodelyPerfMetricsQueryOptions = () =>
  queryOptions({
    queryKey: ['nodely-perf'],
    queryFn: () => fetchNodely24hPerf(),
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 30, // 30 mins
    retry: (failureCount, error) => {
      if (error instanceof AxiosError) {
        return error.response?.status !== 404 && failureCount < 3
      }
      return false
    },
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })
