import {
  NfdGhostSDK,
  NfdNotDeployedError,
  NfdQueryUnavailableError,
  type NfdRecord,
} from 'nfd-ghost-sdk'
import { readAlgorand } from '@/api/reti'
import { Nfd } from '@/interfaces/nfd'
import { getNfdRegistryAppIdFromViteEnvironment } from '@/utils/network/getNfdConfig'

/**
 * NFDs are read on chain through `nfd-ghost-sdk`, straight from the NFD registry and NFD apps,
 * on a read node that supports it (a dtalgorand node with read-only queries and foreign box
 * reads). Those reads work at any round, so a time-travelling page shows the NFDs as they were,
 * and lookups made in the same tick share one request.
 *
 * Where the read node can't, or there is no registry to read (localnet), there are no NFDs:
 * every read throws {@link NfdUnavailableError}, and pages show addresses instead.
 */

export interface NfdReadAt {
  round?: bigint
  signal?: AbortSignal
}

/** No NFD has the name or app id (at the round read). */
export class NfdNotFoundError extends Error {
  constructor() {
    super('NFD not found')
    this.name = 'NfdNotFoundError'
  }
}

/** Whether a lookup failed because there is no such NFD. */
export function isNfdNotFoundError(error: unknown): boolean {
  return error instanceof NfdNotFoundError
}

/**
 * NFDs can't be read: the read node doesn't support it, or there is no NFD registry. Also a
 * lookup the node can't make, such as segments on a node without time travel (`cause`).
 */
export class NfdUnavailableError extends Error {
  readonly cause?: unknown

  constructor(message = "NFD lookups aren't available on this node", cause?: unknown) {
    super(message)
    this.name = 'NfdUnavailableError'
    this.cause = cause
  }
}

export function isNfdUnavailableError(error: unknown): boolean {
  return error instanceof NfdUnavailableError
}

const NFD_REGISTRY_APP_ID = getNfdRegistryAppIdFromViteEnvironment()
const NFD_DEBUG = import.meta.env.DEV || import.meta.env.VITE_NFD_DEBUG === 'true'

let sdk: NfdGhostSDK | null | undefined

/** The SDK, or null where there is no registry to read (localnet) or no read node (tests). */
function nfdSdk(): NfdGhostSDK | null {
  if (sdk === undefined) {
    sdk =
      readAlgorand && NFD_REGISTRY_APP_ID > 0n
        ? new NfdGhostSDK({
            algorand: readAlgorand,
            registryAppId: NFD_REGISTRY_APP_ID,
            // Each query's args, requests, NFD versions and timings, at the console's verbose level
            debug: NFD_DEBUG,
          })
        : null
  }
  return sdk
}

let support: Promise<boolean> | undefined

/** How long after a failed support check it is asked again. */
const SUPPORT_RECHECK_MS = 1000 * 60 // 1 minute

let recheck: ReturnType<typeof setTimeout> | undefined
let failedBefore = false
const answeredAfterFailure = new Set<() => void>()

/**
 * Calls `listener` each time the support check is answered after it failed, so reads that
 * failed on it can be made again. Returns the unsubscribe.
 */
export function onNfdSupportAnsweredAfterFailure(listener: () => void): () => void {
  answeredAfterFailure.add(listener)
  return () => answeredAfterFailure.delete(listener)
}

/**
 * Whether NFDs can be read: on chain through the SDK, at any round. Asked once per session.
 * Rejects when the node couldn't be asked; the next call asks again, and so does a timer after
 * a minute, whether or not anything reads NFDs meanwhile.
 */
export function askNfdQueriesSupported(): Promise<boolean> {
  const reader = nfdSdk()
  if (!reader) {
    return Promise.resolve(false)
  }
  if (!support) {
    const asked = reader.supported()
    asked.then(
      () => {
        if (!failedBefore) return
        failedBefore = false
        answeredAfterFailure.forEach((listener) => listener())
      },
      (error: unknown) => {
        console.warn('Could not tell whether the read node can read NFDs', error)
        if (support === asked) support = undefined
        failedBefore = true
        recheck ??= setTimeout(() => {
          recheck = undefined
          askNfdQueriesSupported().catch(() => {})
        }, SUPPORT_RECHECK_MS)
      },
    )
    support = asked
  }
  return support
}

// Asks before the first page needs the answer
askNfdQueriesSupported().catch(() => {})

/**
 * Runs `read` on the SDK, once the node is known to support it. Throws
 * {@link NfdUnavailableError} where it doesn't or can't make the lookup, and the support check's
 * error when the node couldn't be asked.
 */
async function withReader<T>(read: (sdk: NfdGhostSDK) => Promise<T>): Promise<T> {
  const sdk = nfdSdk()
  if (!sdk || !(await askNfdQueriesSupported())) {
    throw new NfdUnavailableError()
  }
  try {
    return await read(sdk)
  } catch (error) {
    if (error instanceof NfdQueryUnavailableError) {
      throw new NfdUnavailableError("This NFD lookup isn't available on this node", error)
    }
    throw error
  }
}

/** An SDK record in the app's `Nfd` shape (see `@/interfaces/nfd`). */
export function nfdFromRecord(record: NfdRecord): Nfd {
  return {
    name: record.name,
    appID: Number(record.appId),
    asaID: Number(record.asaId),
    owner: record.owner,
    parentAppID: record.parentAppId === null ? undefined : Number(record.parentAppId),
    category: record.category as Nfd['category'],
    // Unowned and expired NFDs are both up for grabs: the API's "available" placeholder
    state:
      record.state === 'owned' ? 'owned' : record.state === 'forSale' ? 'forSale' : 'available',
    caAlgo: record.caAlgo,
    properties: {
      userDefined: {
        ...(record.avatar && { avatar: record.avatar }),
        ...(record.bio && { bio: record.bio }),
      },
    },
    currentAsOfBlock: Number(record.round),
  }
}

/** An NFD by app id or name, at `at.round`. Throws `NfdNotFoundError` if there is none. */
export async function fetchNfd(
  nameOrID: string | bigint | number,
  at: NfdReadAt = {},
): Promise<Nfd> {
  const key = nameOrID.toString()
  const opts = { round: at.round, signal: at.signal }
  const record = await withReader((sdk) =>
    /^\d+$/.test(key) ? sdk.getRecord(BigInt(key), opts) : sdk.resolveName(key, opts),
  )
  if (!record) {
    throw new NfdNotFoundError()
  }
  return nfdFromRecord(record)
}

/**
 * The NFD that has `address` as its primary verified address at `at.round`, or null. A round
 * before the NFD registry existed has none.
 */
export async function fetchNfdReverseLookup(
  address: string,
  at: NfdReadAt = {},
): Promise<Nfd | null> {
  return withReader(async (sdk) => {
    try {
      const nfds = await sdk.reverseLookup([address], { round: at.round, signal: at.signal })
      const primary = nfds.get(address)?.[0]
      return primary ? nfdFromRecord(primary) : null
    } catch (error) {
      if (error instanceof NfdNotDeployedError) {
        return null
      }
      throw error
    }
  })
}

/**
 * The verified address of the NFD `appId` that creator-NFD gating checks, at the latest round:
 * `v.caAlgo.0.as`, as the contract reads it.
 */
export async function fetchNfdGatingAddresses(appId: bigint): Promise<string[]> {
  const record = await withReader((sdk) => sdk.getRecord(appId, { fields: ['caAlgo'] }))
  if (!record) {
    throw new NfdNotFoundError()
  }
  return record.caAlgo0
}

/**
 * The app id of a segment of `parentAppId` that `address` can gate with at the latest round,
 * or 0n if none: any segment it owns or is linked to (`v.caAlgo.0.as`), as the contract accepts.
 * Needs a node with time travel.
 */
export async function fetchNfdGatingSegment(address: string, parentAppId: bigint): Promise<bigint> {
  const segments = await withReader((sdk) =>
    sdk.getSegmentsFor(address, parentAppId, { fields: ['caAlgo'] }),
  )
  return segments[0]?.appId ?? 0n
}
