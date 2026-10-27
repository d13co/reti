import { AxiosError, isAxiosError } from 'axios'
import { CacheRequestConfig } from 'axios-cache-interceptor'
import {
  NfdGhostSDK,
  NfdNotDeployedError,
  NfdQueryUnavailableError,
  type NfdRecord,
} from 'nfd-ghost-sdk'
import { readAlgorand } from '@/api/reti'
import {
  Nfd,
  NfdGetLookup200,
  NfdGetLookupParams,
  NfdGetNFDParams,
  NfdSearchV2Params,
  NfdV2SearchRecords,
} from '@/interfaces/nfd'
import axiosNfdApi from '@/lib/axiosNfdApi'
import { getNfdRegistryAppIdFromViteEnvironment } from '@/utils/network/getNfdConfig'

/**
 * NFDs are read two ways:
 *
 * - On a read node that supports it (a dtalgorand node with read-only queries and foreign box
 *   reads), through `nfd-ghost-sdk`, straight from the NFD registry and NFD apps on chain. Those
 *   reads work at any round, so a time-travelling page shows the NFDs as they were, and lookups
 *   made in the same tick share one request.
 * - Everywhere else, through the NFD REST API, which only knows the present.
 *
 * Every function here takes the round to read at, and picks the way itself.
 */

/** Where an NFD read is made: the round (undefined for the latest) and the signal that stops it. */
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

/** Whether a lookup failed because there is no such NFD: an SDK miss or a REST 404. */
export function isNfdNotFoundError(error: unknown): boolean {
  return (
    error instanceof NfdNotFoundError || (isAxiosError(error) && error.response?.status === 404)
  )
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

/**
 * Whether NFDs are read on chain through the SDK, at any round. Asked once per session; a
 * failure to ask is retried by the next read, which goes through the REST API meanwhile.
 */
export function nfdQueriesSupported(): Promise<boolean> {
  const reader = nfdSdk()
  if (!reader) {
    return Promise.resolve(false)
  }
  if (!support) {
    const asked = reader.supported().catch((error: unknown) => {
      console.warn('Could not tell whether the read node can read NFDs', error)
      if (support === asked) support = undefined
      return false
    })
    support = asked
  }
  return support
}

// Asks before the first page needs the answer
void nfdQueriesSupported()

/** The SDK, if NFDs are read through it. */
async function supportedSdk(): Promise<NfdGhostSDK | null> {
  return (await nfdQueriesSupported()) ? nfdSdk() : null
}

/**
 * Runs an SDK read, falling back to `rest` when the node turns out not to support it, or, for
 * a read at the latest round, when the read fails: REST answers the latest round just as well.
 * A pinned read that fails stays failed rather than showing today's NFDs as the past's.
 */
async function withRestFallback<T>(
  at: NfdReadAt,
  read: (reader: NfdGhostSDK) => Promise<T>,
  rest: () => Promise<T>,
): Promise<T> {
  const reader = await supportedSdk()
  if (!reader) {
    return rest()
  }
  try {
    return await read(reader)
  } catch (error) {
    if (
      error instanceof NfdNotFoundError ||
      error instanceof NfdNotDeployedError ||
      at.signal?.aborted
    ) {
      throw error
    }
    if (error instanceof NfdQueryUnavailableError || at.round === undefined) {
      console.warn('NFD read through the read node failed, using the NFD API', error)
      return rest()
    }
    throw error
  }
}

/**
 * An SDK record in the shape the NFD API gives, which is what the rest of the app reads. Only
 * the fields the SDK reads are set.
 */
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
  params?: NfdGetNFDParams,
  options?: CacheRequestConfig,
  at: NfdReadAt = {},
): Promise<Nfd> {
  const key = nameOrID.toString()
  return withRestFallback(
    at,
    async (reader) => {
      const opts = { round: at.round, signal: at.signal }
      const record = /^\d+$/.test(key)
        ? await reader.getRecord(BigInt(key), opts)
        : await reader.resolveName(key, opts)
      if (!record) {
        throw new NfdNotFoundError()
      }
      return nfdFromRecord(record)
    },
    () => fetchNfdRest(key, params, options),
  )
}

async function fetchNfdRest(
  nameOrID: string,
  params?: NfdGetNFDParams,
  options?: CacheRequestConfig,
): Promise<Nfd> {
  const { data: nfd } = await axiosNfdApi.get<Nfd>(`/nfd/${nameOrID}`, {
    ...options,
    params: { ...params, ...options?.params },
  })

  if (!nfd || !nfd.name) {
    throw new NfdNotFoundError()
  }

  return nfd
}

/**
 * The NFD that has `address` as its primary verified address at `at.round`, or null. A round
 * before the NFD registry existed has none.
 */
export async function fetchNfdReverseLookup(
  address: string,
  params?: Omit<NfdGetLookupParams, 'address'>,
  options?: CacheRequestConfig,
  at: NfdReadAt = {},
): Promise<Nfd | null> {
  try {
    return await withRestFallback(
      at,
      async (reader) => {
        const nfds = await reader.reverseLookup([address], {
          round: at.round,
          signal: at.signal,
        })
        const primary = nfds.get(address)?.[0]
        return primary ? nfdFromRecord(primary) : null
      },
      () => fetchNfdReverseLookupRest(address, params, options),
    )
  } catch (error) {
    if (error instanceof NfdNotDeployedError) {
      return null
    }
    throw error
  }
}

async function fetchNfdReverseLookupRest(
  address: string,
  params?: Omit<NfdGetLookupParams, 'address'>,
  options?: CacheRequestConfig,
): Promise<Nfd | null> {
  try {
    const { data } = await axiosNfdApi.get<NfdGetLookup200>(`/nfd/lookup`, {
      ...options,
      params: { address: [address], ...params, ...options?.params },
    })

    const nfd = data[address]

    return nfd || null
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return null
    }
    throw error
  }
}

/**
 * The verified addresses of the NFD `appId` that creator-NFD gating checks, at the latest
 * round. On chain that is just `v.caAlgo.0.as`, as the contract reads it; the API gives them all.
 */
export async function fetchNfdGatingAddresses(appId: bigint): Promise<string[]> {
  return withRestFallback(
    {},
    async (reader) => {
      const record = await reader.getRecord(appId, { fields: ['caAlgo'] })
      if (!record) {
        throw new NfdNotFoundError()
      }
      return record.caAlgo0
    },
    async () => (await fetchNfdRest(appId.toString(), { view: 'tiny' })).caAlgo || [],
  )
}

/**
 * The app id of a segment of `parentAppId` that `address` can gate with at the latest round,
 * or 0n if none. On chain that is any segment it owns or is linked to (`v.caAlgo.0.as`), as the
 * contract accepts; the API can only find the ones it owns.
 */
export async function fetchNfdGatingSegment(address: string, parentAppId: bigint): Promise<bigint> {
  return withRestFallback(
    {},
    async (reader) => {
      const segments = await reader.getSegmentsFor(address, parentAppId, { fields: ['caAlgo'] })
      return segments[0]?.appId ?? 0n
    },
    async () => {
      const result = await fetchNfdSearch(
        { parentAppID: parentAppId, state: ['owned'], owner: address, view: 'brief', limit: 1 },
        { cache: false },
      )
      return result.nfds.length > 0 ? BigInt(result.nfds[0].appID!) : 0n
    },
  )
}

export async function fetchNfdSearch(
  params: NfdSearchV2Params,
  options?: CacheRequestConfig,
): Promise<NfdV2SearchRecords> {
  const { data: result } = await axiosNfdApi.get<NfdV2SearchRecords>(`/nfd/v2/search`, {
    ...options,
    params: { ...params, ...options?.params },
  })

  return result
}
