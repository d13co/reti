import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { queryOptions } from '@tanstack/react-query'
import { RetiGhostSDK, type RoundTime } from 'reti-ghost-sdk'
import { algorandClient, RETI_APP_ID } from '@/api/clients'
import { roundTimes, timestampOf, type TimeReader } from '@/api/roundTimes'
import { isoTime, traceQuery } from '@/api/trace'
import {
  getAlgodConfigFromViteEnvironment,
  getReadAlgodConfigFromViteEnvironment,
} from '@/utils/network/getAlgoClientConfigs'
import { sleep } from '@/utils/time'

/**
 * The algod every protocol read goes through. A dtalgorand node here makes every read work at
 * any past round; the regular `algorandClient` (see `@/api/clients`) keeps serving the wallet,
 * writes and the reads writes depend on.
 */
export const readAlgorand = AlgorandClient.fromConfig({
  algodConfig: getReadAlgodConfigFromViteEnvironment(),
})

/** The only `RetiGhostSDK`. Read through {@link sdkAt} so a pinned round is never forgotten. */
export const retiSdk = new RetiGhostSDK({ algorand: readAlgorand, registryAppId: RETI_APP_ID })

// Fetch what the first read of every page waits on, so it doesn't happen inside that read: the
// node's limits (queries, extended simulate or plain simulate), suggested params on a node without
// queries, and the registry's creation round that pinned reads check against. The SDK caches all of
// it; a failure here is retried by the read that needs it.
retiSdk.prefetch().catch(() => {})

/** How long a read of the read node's latest round is reused. */
const LATEST_ROUND_MAX_AGE = 1000 * 3 // 3 seconds

let latestRead: { at: number; round: Promise<bigint> } | undefined

/**
 * The read node's latest round, for "now" in live metrics: the same node the live reads come
 * from. One status read serves every caller for a few seconds (the dashboard's metrics ask once
 * per validator).
 */
export function latestReadRound(): Promise<bigint> {
  if (!latestRead || Date.now() - latestRead.at > LATEST_ROUND_MAX_AGE) {
    const round = readAlgorand.client.algod
      .status()
      .do()
      .then((status) => status.lastRound)
    round.catch(() => {
      if (latestRead?.round === round) latestRead = undefined
    })
    latestRead = { at: Date.now(), round }
  }
  return latestRead.round
}

const readConfig = getReadAlgodConfigFromViteEnvironment()
const writeConfig = getAlgodConfigFromViteEnvironment()

/** Whether reads go to another node than writes, which may be a block or two behind it. */
const SEPARATE_READ_NODE =
  readConfig.server !== writeConfig.server || String(readConfig.port) !== String(writeConfig.port)

/** How long a write waits for the read node to catch up, before its reads go ahead anyway. */
const READ_NODE_CATCH_UP_MS = 1000 * 15 // 15 seconds

/**
 * Waits until the read node has every block the write node has, so the reads that follow a
 * confirmed write see it. Returns at once when reads and writes share a node. Gives up after
 * {@link READ_NODE_CATCH_UP_MS}, or if either node can't be asked: the reads then go ahead, and
 * may be a round behind.
 */
export async function untilReadNodeCaughtUp(): Promise<void> {
  if (!SEPARATE_READ_NODE) return
  try {
    const target = (await algorandClient.client.algod.status().do()).lastRound
    const deadline = Date.now() + READ_NODE_CATCH_UP_MS
    let { lastRound } = await readAlgorand.client.algod.status().do()
    while (lastRound < target) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      // Answers once the read node has the next block
      const next = await Promise.race([
        readAlgorand.client.algod
          .statusAfterBlock(lastRound)
          .do()
          .then((status) => status.lastRound),
        sleep(remaining).then(() => undefined),
      ])
      if (next === undefined) return
      lastRound = next
    }
  } catch (error) {
    console.warn('Could not wait for the read node to catch up after a write', error)
  } finally {
    // "Now" moved on with the write
    latestRead = undefined
  }
}

/** The SDK reading as of the end of `round`, or the latest state when `round` is undefined. */
export function sdkAt(round?: bigint): RetiGhostSDK {
  return round === undefined ? retiSdk : retiSdk.atRound(round)
}

let creation: Promise<RoundTime | undefined> | undefined

/**
 * The registry's creation round and its block time, from its first version: one request per
 * session, kept with the page's round ↔ time pairs. Undefined on a node without history.
 */
export function registryCreation(): Promise<RoundTime | undefined> {
  if (!creation) {
    const trace = traceQuery('registry-creation')
    creation = trace
      .step(
        'changes',
        { target: 'registry', minRound: 1, order: 'asc', limit: 1 },
        async () => {
          const page = await retiSdk.getChangeRounds(
            { registry: true },
            { minRound: 1n, order: 'asc', limit: 1 },
          )
          const first = page.changes[0]
          if (first) roundTimes.add(first.round, first.timestamp)
          return first && { round: first.round, timestamp: first.timestamp }
        },
        (first) => (first ? `round=${first.round} at ${isoTime(first.timestamp)}` : 'none'),
      )
      .then((first) => {
        trace.done()
        return first
      })
    creation.catch(() => (creation = undefined))
    roundTimes.track(creation, 'earliest')
  }
  return creation
}

/** The reads a date → round search makes: each one batched read of the SDK's reader. */
export const timeReader: TimeReader = {
  async timestampsAt(rounds, signal) {
    const points = await retiSdk.getTimestampsAtRounds(rounds, { signal })
    return points.flatMap((point) =>
      point.ok ? [{ round: point.round, timestamp: point.value }] : [],
    )
  },

  firstRoundAtOrAfter: (start, target, knownRound, signal) =>
    retiSdk.firstRoundAtOrAfter(start, target, { knownRound, signal }),

  async latest(signal) {
    const { lastRound } = await readAlgorand.client.algod
      .status()
      .do(undefined, signal && { signal })
    return { round: lastRound, timestamp: await retiSdk.timestampOf(lastRound, { signal }) }
  },

  earliest: registryCreation,
}

export interface TimeTravelSupport {
  /** Whether the read node can serve any past round (a dtalgorand node with time travel). */
  supported: boolean
  /** The registry's creation round: the earliest round there is anything to show. */
  creationRound?: bigint
  /** That round's block timestamp, in seconds. */
  creationTimestamp?: number
}

/** Whether the history features can be offered at all. Asked once per session. */
export const timeTravelSupportQueryOptions = queryOptions({
  queryKey: ['time-travel-support'],
  queryFn: async (): Promise<TimeTravelSupport> => {
    const trace = traceQuery('time-travel-support')
    const supported = await trace
      .step('supports-time-travel', {}, () => retiSdk.supportsTimeTravel(), String)
      .catch(() => false)
    if (!supported) {
      trace.done('unsupported')
      return { supported }
    }
    const first = await registryCreation()
    trace.done(first ? `creation=${first.round}` : 'no creation round')
    return { supported, creationRound: first?.round, creationTimestamp: first?.timestamp }
  },
  staleTime: Infinity,
  gcTime: Infinity,
  retry: 1,
})

/** A round's block timestamp, in seconds. Past headers never change. */
export const roundTimestampQueryOptions = (round?: bigint) =>
  queryOptions({
    queryKey: ['round-timestamp', round?.toString()],
    queryFn: async () => {
      const trace = traceQuery('round-timestamp')
      const timestamp = await timestampOf(trace, retiSdk, round!)
      trace.done()
      return timestamp
    },
    enabled: round !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  })
