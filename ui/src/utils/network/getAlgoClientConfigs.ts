import { NetworkId } from '@txnlab/use-wallet-react'
import { AlgoViteClientConfig, AlgoViteKMDConfig } from '@/interfaces/network'

export function getAlgodConfigFromViteEnvironment(): AlgoViteClientConfig {
  if (!import.meta.env.VITE_ALGOD_SERVER) {
    throw new Error(
      'Attempt to get default algod configuration without specifying VITE_ALGOD_SERVER in the environment variables',
    )
  }

  return {
    server: import.meta.env.VITE_ALGOD_SERVER,
    // Hosts like Cloudflare Pages drop empty env vars, and use-wallet rejects a missing token
    port: import.meta.env.VITE_ALGOD_PORT ?? '',
    token: import.meta.env.VITE_ALGOD_TOKEN ?? '',
    network: import.meta.env.VITE_ALGOD_NETWORK,
  }
}

export function getIndexerConfigFromViteEnvironment(): AlgoViteClientConfig {
  if (!import.meta.env.VITE_INDEXER_SERVER) {
    throw new Error(
      'Attempt to get default algod configuration without specifying VITE_INDEXER_SERVER in the environment variables',
    )
  }

  return {
    server: import.meta.env.VITE_INDEXER_SERVER,
    port: import.meta.env.VITE_INDEXER_PORT,
    token: import.meta.env.VITE_INDEXER_TOKEN,
    network: import.meta.env.VITE_ALGOD_NETWORK,
  }
}

export function getKmdConfigFromViteEnvironment(): AlgoViteKMDConfig {
  if (!import.meta.env.VITE_KMD_SERVER) {
    throw new Error(
      'Attempt to get default kmd configuration without specifying VITE_KMD_SERVER in the environment variables',
    )
  }

  return {
    server: import.meta.env.VITE_KMD_SERVER,
    port: import.meta.env.VITE_KMD_PORT,
    token: import.meta.env.VITE_KMD_TOKEN,
    wallet: import.meta.env.VITE_KMD_WALLET,
    password: import.meta.env.VITE_KMD_PASSWORD,
  }
}

export function getAlgodNetwork(): NetworkId {
  const config = getAlgodConfigFromViteEnvironment()

  switch (config.network) {
    case 'mainnet':
      return NetworkId.MAINNET
    case 'testnet':
      return NetworkId.TESTNET
    case 'betanet':
      return NetworkId.BETANET
    case 'fnet':
      return NetworkId.FNET
    case 'localnet':
      return NetworkId.LOCALNET
    default:
      throw new Error(`Unknown network: ${config.network}`)
  }
}

/**
 * The algod every protocol read goes through (via reti-ghost-sdk). Point it at a dtalgorand node
 * to read at any past round; reads at the latest round work on any algod. Falls back to the
 * regular algod, which keeps serving wallet signing and writes either way.
 */
export function getReadAlgodConfigFromViteEnvironment(): AlgoViteClientConfig {
  if (!import.meta.env.VITE_DT_ALGOD_SERVER) {
    return getAlgodConfigFromViteEnvironment()
  }

  return {
    server: import.meta.env.VITE_DT_ALGOD_SERVER,
    port: import.meta.env.VITE_DT_ALGOD_PORT ?? '',
    token: import.meta.env.VITE_DT_ALGOD_TOKEN ?? '',
    network: import.meta.env.VITE_ALGOD_NETWORK,
  }
}
