import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { keepPreviousData, QueryClient, queryOptions } from '@tanstack/react-query'
import algosdk from 'algosdk'
import { AxiosError } from 'axios'
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
import { askNfdQueriesSupported, fetchNfd, fetchNfdReverseLookup } from '@/api/nfd'
import { fetchNodely24hPerf } from '@/api/nodely'
import { latestReadRound, timeTravelSupportQueryOptions } from '@/api/reti'
import { count, type Trace, traceQuery, traceRead } from '@/api/trace'
import { Nfd } from '@/interfaces/nfd'
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
      const validators = await traceRead(
        'all-validators',
        'fetchAllValidatorData',
        { round },
        () => fetchAllValidatorData(round, signal),
        (validators) => `validators=${validators.length}`,
        signal,
      )
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
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead('mbr', 'fetchMbrAmounts', { round }, () => fetchMbrAmounts(round, signal))
    },
    ...roundQueryDefaults(round, { staleTime: Infinity }),
  })

export const constraintsQueryOptions = (round?: bigint) =>
  queryOptions({
    queryKey: ['constraints', roundKey(round)],
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead('constraints', 'fetchProtocolConstraints', { round }, () =>
        fetchProtocolConstraints(round, signal),
      )
    },
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
    queryFn: () =>
      traceRead('validator-config', 'fetchValidatorConfig', { validatorId, round }, () =>
        fetchValidatorConfig(validatorId, round),
      ),
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
    queryFn: () =>
      traceRead('validator-state', 'fetchValidatorState', { validatorId, round }, () =>
        fetchValidatorState(validatorId, round),
      ),
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
    queryFn: () =>
      traceRead(
        'validator-pools',
        'fetchValidatorPools',
        { validatorId, round },
        () => fetchValidatorPools(validatorId, round),
        (pools) => `pools=${pools.length}`,
      ),
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
    queryFn: () =>
      traceRead(
        'validator-node-pool-assignments',
        'fetchValidatorNodePoolAssignments',
        { validatorId, round },
        () => fetchValidatorNodePoolAssignments(validatorId, round),
      ),
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
      return traceRead(
        'pool-global-states',
        'fetchPoolGlobalStates',
        { pools: poolAppIds.length, round },
        () => fetchPoolGlobalStates(poolAppIds, round, signal),
        (states) => `pools=${count(states)}`,
        signal,
      )
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
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead(
        `validator-pool-states ${validatorId}`,
        'fetchPoolGlobalStates',
        { pools: pools.length, round },
        () =>
          fetchPoolGlobalStates(
            pools.map((pool) => pool.poolAppId),
            round,
            signal,
          ),
        (states) => `pools=${count(states)}`,
        signal,
      )
    },
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
      const signal = pinnedSignal(round, context)
      const trace = traceQuery(`validator-metrics ${validatorId}`, signal)
      const poolsData = await metricsPoolData(
        queryClient,
        validatorId,
        pools,
        round,
        epochRoundLength,
        signal,
      )
      const currentRound = round ?? (await tracedLatestReadRound(trace))
      trace.done(`pools=${poolsData.length}`)

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
    (await traceRead(
      `metrics-pool-states ${validatorId}`,
      'fetchPoolGlobalStates (not cached)',
      { pools: pools.length, round },
      () =>
        fetchPoolGlobalStates(
          pools.map((pool) => pool.poolAppId),
          round,
          signal,
        ),
      (states) => `pools=${count(states)}`,
      signal,
    ))

  return pools
    .map((pool) =>
      processPoolData(pool, poolGlobalStates[String(pool.poolAppId)], epochRoundLength),
    )
    .filter((pool) => pool.balance >= AlgoAmount.Algos(30_000).microAlgos)
}

/** The read node's latest round, logged; one status read serves every caller for a few seconds. */
const tracedLatestReadRound = (trace: Trace) =>
  trace.step('latestReadRound', { shared: true }, latestReadRound, (round) => `latest=${round}`)

/**
 * Windows start on a multiple of this: live, so the read at their start stays cached between
 * refreshes rather than moving with every new round; and at any round, so validators whose windows
 * start near each other read their stakers there in one batched query (see `getPoolStakers`).
 */
const REALISED_START_STEP = 10_000n

/**
 * A validator's APY from what its stakers earned over the last {@link REALISED_APY_DAYS} days
 * (or three epochs, if longer): the figure the dashboard shows wherever it can. The pools' on-chain
 * moving average swings day to day (a pool over 300k ALGO weighs each new day at 90%), and for
 * pools paying out less than daily it reads several times too high, even corrected
 * (`epochAdjustedApy`). Two staker-list reads per pool, at the round shown and the window's start;
 * the one at the round shown is the Staking Details' own. The SDK batches every pool's read at a
 * round into one query, so all validators at once cost a few requests. A pool with no figure
 * (younger than the window or two epochs, or with every staker adding or removing stake in it)
 * keeps its corrected average. Null when no pool has a figure, or the read node can't read past
 * rounds.
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
      const trace = traceQuery(`realised-apy ${validatorId}`, signal)
      // The window's start is a past round, which only a node with time travel can read. Asked
      // once per session, so a node without it costs nothing here.
      const support = await queryClient.ensureQueryData(timeTravelSupportQueryOptions)
      if (!support.supported) {
        trace.done('no time travel')
        return null
      }
      const poolsData = await metricsPoolData(
        queryClient,
        validatorId,
        pools,
        round,
        epochRoundLength,
        signal,
      )
      const end = round ?? (await tracedLatestReadRound(trace))

      let anyMeasured = false
      const measured = await Promise.all(
        poolsData.map(async (pool): Promise<PoolData> => {
          const days = epochDays(epochRoundLength, pool.roundsPerDay)
          if (!pool.poolAppId) return pool
          const perDay = pool.roundsPerDay || APPROX_ROUNDS_PER_DAY
          // At least three payouts' worth, for the longest epochs
          const targetDays = Math.max(REALISED_APY_DAYS, 3 * days)
          let start = end - BigInt(Math.ceil(targetDays * Number(perDay)))
          start -= start % REALISED_START_STEP
          if (support.creationRound !== undefined && start < support.creationRound) {
            start = support.creationRound
          }
          const windowDays = Number(end - start) / Number(perDay)
          // Fewer than two payouts in the window is too few to go on
          if (windowDays < 2 * days) return pool
          try {
            const poolAppId = pool.poolAppId
            // Cached reads others share (the Staking Details' own), so only the wait is cancelled.
            // The SDK logs the batched reads behind them.
            const [before, after] = await untilAborted(
              Promise.all([
                queryClient.ensureQueryData(stakedInfoQueryOptions(poolAppId, start)),
                queryClient.ensureQueryData(stakedInfoQueryOptions(poolAppId, round)),
              ]),
              signal,
            )
            const apy = realisedApy(before, after, windowDays)
            if (apy === undefined) return pool
            anyMeasured = true
            return { ...pool, apy }
          } catch (error) {
            if (signal?.aborted) throw error
            // Say, a node that can't read past rounds: the corrected average stands
            return pool
          }
        }),
      )
      const apy = anyMeasured ? weightedPoolApy(measured).apy : null
      trace.done(`pools=${poolsData.length}, apy=${apy === null ? 'none' : apy.toFixed(2)}`)
      return apy
    },
    ...roundQueryDefaults(round, {
      staleTime: METRICS_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchOnWindowFocus: false,
    }),
  })

/**
 * A validator's APY by Nodely's realtime figures, which also count external deposits: read only
 * on a node without time travel, which can't give the realised APY, in place of the on-chain
 * moving average its metrics carry. Nodely can be wrong: it has reported ~5% for a pool offline
 * for a month. One Nodely request per counted pool, so
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
      const trace = traceQuery(`nodely-apy ${validatorId}`)
      const poolsData = await metricsPoolData(queryClient, validatorId, pools)
      const withNodely = await Promise.all(
        poolsData.map(async (pool) => ({
          ...pool,
          ...(await trace.step(
            'fetchNodelyPoolApy',
            { pool: pool.poolAppId },
            () => fetchNodelyPoolApy(pool.poolAppId!),
            ({ apy, extDeposits }) => `apy=${apy}, extDeposits=${extDeposits}`,
          )),
        })),
      )
      const weighted = weightedPoolApy(withNodely)
      trace.done(`pools=${poolsData.length}, apy=${weighted.apy.toFixed(2)}`)
      return weighted
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
    queryFn: (context) => {
      // Not traced: the SDK batches every pool's stakers at a round and logs the batch.
      const signal = pinnedSignal(round, context)
      signal?.throwIfAborted()
      return fetchStakedInfoForPool(poolAppId, round, signal)
    },
    enabled: !!poolAppId,
    ...roundQueryDefaults(round, {}),
  })

export const stakesQueryOptions = (staker: string | null, round?: bigint) =>
  queryOptions({
    queryKey: ['stakes', { staker }, roundKey(round)],
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead(
        'stakes',
        'fetchStakerValidatorData',
        { staker, round },
        () => fetchStakerValidatorData(staker!, round, signal),
        (stakes) => `validators=${stakes.length}`,
        signal,
      )
    },
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
 * Whether NFDs can be read: on chain through `nfd-ghost-sdk`, at any round. Asked once per
 * session. If the node couldn't be asked, the query fails; `@/api/nfd` asks again a minute later,
 * and once it answers, this query and the NFD reads that failed on it are made again (see
 * `main.tsx`). It isn't retried at once: while it retries, it would stay pending, and the NFDs
 * that wait on it would wait too.
 */
export const nfdSupportQueryOptions = queryOptions({
  queryKey: ['nfd-support'],
  queryFn: () =>
    traceRead('nfd-support', 'askNfdQueriesSupported', {}, askNfdQueriesSupported, String),
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
})

/** The key roots of NFD reads. */
export const NFD_QUERY_ROOTS: readonly string[] = ['nfd', 'nfd-lookup']

/**
 * NFD records change rarely, and each read is one batched query on the read node, so latest
 * reads are reused for a few minutes. These keys are also persisted to IndexedDB (see
 * `@/lib/queryPersister`), so a reload paints names and avatars before the first read.
 *
 * Keys end with the round, like every protocol read: NFDs are read as of that round (see
 * `@/api/nfd`).
 */
const NFD_STALE_TIME = 1000 * 60 * 5 // 5 minutes

/**
 * Not retried: the algod client already retries a busy or failing node, and an NFD that can't be
 * read (no such NFD, or a node that can't read NFDs) won't be read on another try.
 */
const nfdRetry = false

export const nfdQueryOptions = (nameOrId: string | number | bigint, round?: bigint) =>
  queryOptions<Nfd>({
    queryKey: ['nfd', nameOrId.toString(), roundKey(round)],
    queryFn: (context) => {
      // Not traced: the SDK batches NFD reads and logs the batch.
      const signal = pinnedSignal(round, context)
      signal?.throwIfAborted()
      return fetchNfd(nameOrId.toString(), { round, signal })
    },
    enabled: !!nameOrId,
    placeholderData: keepPreviousData,
    retry: nfdRetry,
    ...roundQueryDefaults(round, {
      staleTime: NFD_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchOnWindowFocus: false,
    }),
  })

export const nfdLookupQueryOptions = (address: string | null, round?: bigint) =>
  queryOptions<Nfd | null>({
    queryKey: ['nfd-lookup', address, roundKey(round)],
    queryFn: (context) => {
      // Not traced: the SDK batches these reverse lookups and logs the batch.
      const signal = pinnedSignal(round, context)
      signal?.throwIfAborted()
      return fetchNfdReverseLookup(String(address), { round, signal })
    },
    enabled: !!address,
    retry: nfdRetry,
    ...roundQueryDefaults(round, {
      staleTime: NFD_STALE_TIME,
      gcTime: PERSISTED_GC_TIME,
      refetchOnWindowFocus: false,
    }),
  })

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
    queryFn: (context) => {
      // Not traced: the SDK batches asset reads at a round and logs the batch.
      const signal = pinnedSignal(round, context)
      signal?.throwIfAborted()
      return fetchAssetAt(assetId, round, signal)
    },
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
    queryFn: () =>
      traceRead('account-balance', 'fetchBalance', { address }, () => fetchBalance(address)),
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
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead(
        'historical-balance',
        'fetchBalanceAt',
        { address, round },
        () => fetchBalanceAt(address, round, signal),
        undefined,
        signal,
      )
    },
    enabled: !!address,
    ...roundQueryDefaults(round, {}),
  })

////////////////////////////////////////////////////////////
// IPFS queries
////////////////////////////////////////////////////////////

export const ipfsUrlQueryOptions = (ipfsUrl: string) =>
  queryOptions({
    queryKey: ['ipfs-url', ipfsUrl],
    queryFn: () =>
      traceRead('ipfs-url', 'resolveIpfsUrl', { ipfsUrl }, () => resolveIpfsUrl(ipfsUrl)),
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
    queryFn: (context) => {
      const signal = pinnedSignal(round, context)
      return traceRead(
        'block-times',
        'fetchBlockTimes',
        { round },
        () => fetchBlockTimes(round, undefined, signal),
        (times) => `times=${times.length}`,
        signal,
      )
    },
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
    queryFn: () => traceRead('nodely-perf', 'fetchNodely24hPerf', {}, fetchNodely24hPerf),
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
