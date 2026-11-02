/**
 * The APY figures the dashboard can show, for MainNet pools of each kind: small (average stake
 * under 300k ALGO, where the pool's moving average moves 10% a day) and large (over 300k, 90% a
 * day), paying out daily or more often (short epoch) and less often (long epoch). For each pool it
 * reads the on-chain moving average now and once a day over the last 30, the epoch-corrected
 * average, the realised APY (what stakers earned, from the staker lists at both ends of the
 * window) now and two days ago, and Nodely's realtime figure, and prints them side by side.
 *
 * It checks what the code is responsible for: the staker lists for every window go out as one
 * batched query per round, and match REST box reads; the realised APY is plausible wherever enough
 * of the stake held still to give one; the correction divides by the epoch in days.
 *
 * Run against a dtalgorand MainNet node with queries (VITE_DT_ALGOD_* in .env.mainnet):
 *   pnpm exec vitest run --config vitest.live.config.mjs --mode mainnet src/api/apy.live.ts
 */
/* eslint-disable no-console -- prints the figures it compares */
import algosdk from 'algosdk'
import { RetiGhostSDK, type PoolStaker } from 'reti-ghost-sdk'
import { RETI_APP_ID } from '@/api/clients'
import { readAlgorand, retiSdk } from '@/api/reti'
import {
  APPROX_ROUNDS_PER_DAY,
  epochAdjustedApy,
  epochDays,
  REALISED_APY_DAYS,
  realisedApy,
} from '@/utils/contracts'

/** Above this average stake (microAlgo) the pool contract weighs each new day at 90%, not 10% */
const LARGE_STAKE = 300_000_000_000n
/** Pools under this balance don't count towards a validator's APY in the dashboard */
const MIN_COUNTED_BALANCE = 30_000_000_000n
const PER_KIND = 4
const NODELY = 'https://afmetrics.api.nodely.io/v1/realtime/reti/pool'

type Kind = 'small/short' | 'large/short' | 'small/long' | 'large/long'

type Pool = {
  validatorId: number
  poolAppId: bigint
  address: string
  kind: Kind
  staked: bigint
  numStakers: number
  perDay: bigint
  /** The validator's epoch, in rounds */
  epoch: number
  days: number
}

// Requests by path, to see how the staker reads went out
const requests = new Map<string, number>()
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  const path = url.pathname.replace(/\d{5,}/g, 'N')
  requests.set(path, (requests.get(path) ?? 0) + 1)
  return realFetch(input, init)
}) as typeof fetch
const count = (path: string) => requests.get(path) ?? 0

const ewmaToApy = (ewma: bigint) => Number(ewma) / 100
const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toFixed(2))

/** Stakers counted by `realisedApy`: in both lists, balance grown by exactly their rewards */
function counted(before: PoolStaker[], after: PoolStaker[]): number {
  const earlier = new Map(before.map((s) => [s.account, s]))
  return after.filter((s) => {
    const then = earlier.get(s.account)
    return then && s.balance - then.balance === s.totalRewarded - then.totalRewarded
  }).length
}

/** The window the dashboard measures a pool over, ending at `end` (see realisedApyQueryOptions) */
function windowFor(pool: Pool, end: bigint) {
  const targetDays = Math.max(REALISED_APY_DAYS, 3 * pool.days)
  let start = end - BigInt(Math.ceil(targetDays * Number(pool.perDay)))
  start -= start % 10_000n
  return { start, days: Number(end - start) / Number(pool.perDay) }
}

async function nodelyApy(address: string): Promise<number | undefined> {
  try {
    const response = await realFetch(`${NODELY}/${address}/apy`)
    if (!response.ok) return undefined
    return ((await response.json()) as { apy: number }).apy
  } catch {
    return undefined
  }
}

describe('APY by pool kind', () => {
  let latest: bigint
  let pools: Pool[]

  beforeAll(async () => {
    const node = await retiSdk.getNode()
    if (node.kind !== 'dt' || !node.query) throw new Error('needs a dtalgorand node with queries')
    latest = (await readAlgorand.client.algod.status().do()).lastRound - 2n

    const validators = await retiSdk.getAllValidators({ round: latest })
    const entries = validators.flatMap((v, i) =>
      v.poolInfo
        .filter(([poolAppId]) => poolAppId > 0n)
        .map(([poolAppId]) => ({
          validatorId: i + 1,
          poolAppId,
          epoch: v.config.epochRoundLength,
        })),
    )
    const states = await retiSdk.getPoolStates(
      entries.map((e) => e.poolAppId),
      { round: latest },
    )
    const all = entries.flatMap((e, i): Pool[] => {
      const state = states[i]
      if (!state.exists || state.balance - state.minBalance < MIN_COUNTED_BALANCE) return []
      if (state.numStakers < 5n) return []
      const perDay = state.roundsPerDay || APPROX_ROUNDS_PER_DAY
      const days = epochDays(e.epoch, perDay)
      const size = state.staked > LARGE_STAKE ? 'large' : 'small'
      return [
        {
          validatorId: e.validatorId,
          poolAppId: e.poolAppId,
          address: algosdk.getApplicationAddress(e.poolAppId).toString(),
          kind: `${size}/${days > 1 ? 'long' : 'short'}` as Kind,
          staked: state.staked,
          numStakers: Number(state.numStakers),
          perDay,
          epoch: e.epoch,
          days,
        },
      ]
    })
    // the pools with the most stakers of each kind: the most stakers to measure by
    const kinds: Kind[] = ['small/short', 'large/short', 'small/long', 'large/long']
    pools = kinds.flatMap((kind) =>
      all
        .filter((p) => p.kind === kind)
        .sort((a, b) => b.numStakers - a.numStakers)
        .slice(0, PER_KIND),
    )
    console.log(
      `round ${latest}: ${all.length} counted pools;`,
      kinds.map((k) => `${k} ${all.filter((p) => p.kind === k).length}`).join(', '),
    )
  })

  it('reads every window in one batched query per round, matching REST box reads', async () => {
    const ends = [latest, latest - 2n * APPROX_ROUNDS_PER_DAY]
    const reads = pools.flatMap((pool) =>
      ends.flatMap((end) => [windowFor(pool, end).start, end]).map((round) => ({ pool, round })),
    )
    const rounds = new Set(reads.map((r) => r.round))
    const before = count('/v2/query')
    // one call per pool and round, as the dashboard makes them: the SDK coalesces them
    const lists = await Promise.all(
      reads.map(({ pool, round }) => retiSdk.getPoolStakers(pool.poolAppId, { round })),
    )
    const queries = count('/v2/query') - before
    console.log(`${reads.length} staker reads at ${rounds.size} rounds: ${queries} queries`)
    expect(queries).toBeLessThanOrEqual(rounds.size)

    const rest = new RetiGhostSDK({
      algorand: readAlgorand,
      registryAppId: RETI_APP_ID,
      backend: 'dt',
    })
    const restLists = await Promise.all(
      reads.map(({ pool, round }) => rest.getPoolStakers(pool.poolAppId, { round })),
    )
    expect(lists).toEqual(restLists)
  })

  it('compares the figures for each kind of pool', async () => {
    const rows = await Promise.all(
      pools.map(async (pool) => {
        const daily = Array.from({ length: 30 }, (_, d) => latest - BigInt(d) * pool.perDay)
        const states = await Promise.all(
          daily.map((round) => retiSdk.getPoolStates([pool.poolAppId], { round })),
        )
        const ewmas = states.map(([s]) => ewmaToApy(s.ewma))
        const now = ewmas[0]
        const corrected = epochAdjustedApy(now, pool.epoch, pool.perDay)
        const realisedAt = async (end: bigint) => {
          const { start, days } = windowFor(pool, end)
          const [before, after] = await Promise.all([
            retiSdk.getPoolStakers(pool.poolAppId, { round: start }),
            retiSdk.getPoolStakers(pool.poolAppId, { round: end }),
          ])
          return { apy: realisedApy(before, after, days), counted: counted(before, after), days }
        }
        const [realised, realised2d, nodely] = await Promise.all([
          realisedAt(latest),
          realisedAt(latest - 2n * pool.perDay),
          nodelyApy(pool.address),
        ])
        return { pool, now, corrected, ewmas, realised, realised2d, nodely }
      }),
    )

    console.log(
      [
        'kind         validator  pool        staked(kALGO) stakers epoch(d) ewma  ewma30d[min..max] mean  corrected realised(n) realised-2d nodely',
        ...rows.map(({ pool, now, corrected, ewmas, realised, realised2d, nodely }) => {
          const mean = ewmas.reduce((a, b) => a + b, 0) / ewmas.length
          return [
            pool.kind.padEnd(12),
            String(pool.validatorId).padStart(9),
            String(pool.poolAppId).padStart(11),
            String(Number(pool.staked / 1_000_000_000n)).padStart(13),
            String(pool.numStakers).padStart(7),
            pool.days.toFixed(2).padStart(8),
            fmt(now).padStart(5),
            `[${fmt(Math.min(...ewmas))}..${fmt(Math.max(...ewmas))}]`.padStart(17),
            fmt(mean).padStart(5),
            fmt(corrected).padStart(9),
            `${fmt(realised.apy)}(${realised.counted})`.padStart(11),
            fmt(realised2d.apy).padStart(11),
            fmt(nodely).padStart(6),
          ].join(' ')
        }),
      ].join('\n'),
    )

    for (const { pool, now, corrected, realised } of rows) {
      // the correction divides a long epoch's average by its length in days, and leaves short ones
      expect(corrected).toBeCloseTo(pool.days > 1 ? now / pool.days : now, 6)
      // where enough of the stake held still to measure by, the realised APY is plausible (0 for
      // a pool that earned nothing, as one that was offline all month)
      if (realised.apy !== undefined) {
        expect(realised.counted).toBeGreaterThan(0)
        expect(realised.apy).toBeGreaterThanOrEqual(0)
        expect(realised.apy).toBeLessThan(25)
      }
    }
  })
})
