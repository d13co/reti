export function getNfdApiFromViteEnvironment(): string {
  if (!import.meta.env.VITE_NFD_API_URL) {
    throw new Error(
      'Attempt to get NFD API base URL without specifying VITE_NFD_API_URL in the environment variables',
    )
  }

  return import.meta.env.VITE_NFD_API_URL
}

export function getNfdAppFromViteEnvironment(): string {
  if (!import.meta.env.VITE_NFD_APP_URL) {
    throw new Error(
      'Attempt to get NFD app base URL without specifying VITE_NFD_APP_URL in the environment variables',
    )
  }

  return import.meta.env.VITE_NFD_APP_URL
}

/** The NFD registry on each public network, for environments that don't set one. */
const DEFAULT_NFD_REGISTRY_APP_IDS: Record<string, bigint> = {
  mainnet: 760937186n,
  testnet: 84366825n,
  betanet: 842656530n,
}

/**
 * The NFD registry app id, from `VITE_NFD_REGISTRY_APP_ID`, else the network's own registry.
 * 0 when there is none (localnet): NFDs are then only read through the REST API.
 */
export function getNfdRegistryAppIdFromViteEnvironment(): bigint {
  const configured = import.meta.env.VITE_NFD_REGISTRY_APP_ID?.trim()
  if (configured) {
    return BigInt(configured)
  }
  return DEFAULT_NFD_REGISTRY_APP_IDS[import.meta.env.VITE_ALGOD_NETWORK] ?? 0n
}
