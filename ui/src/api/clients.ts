import algosdk from 'algosdk'
import { FEE_SINK } from '@/constants/accounts'
import { StakingPoolClient, StakingPoolFactory } from '@/contracts/StakingPoolClient'
import { ValidatorRegistryClient } from '@/contracts/ValidatorRegistryClient'
import {
  getRetiAppIdFromViteEnvironment,
  getXGovRegistryAppIdFromViteEnvironment,
} from '@/utils/env'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network/getAlgoClientConfigs'
import { parseRound } from '@/utils/round'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
// @ts-expect-error module resolution issue
import { XGovRegistryClient } from '@algorandfoundation/xgov-clients/registry'

const algodConfig = getAlgodConfigFromViteEnvironment()

export const algorandClient = AlgorandClient.fromConfig({ algodConfig })
  .setDefaultValidityWindow(900)
  .setSuggestedParamsCacheTimeout(1000 * 60 * 5) // 5 minutes

export const RETI_APP_ID = BigInt(getRetiAppIdFromViteEnvironment())
export const XGOV_REGISTRY_APP_ID = BigInt(getXGovRegistryAppIdFromViteEnvironment())

/**
 * Thrown when a write is attempted while time travelling. The UI disables every write action at a
 * past round; this is the safety net under it.
 */
export class ReadOnlyError extends Error {
  constructor() {
    super('Viewing a past round is read-only. Return to the present to make changes.')
    this.name = 'ReadOnlyError'
  }
}

/**
 * Whether the app is showing a past round: the root route's `?round=`, parsed as the UI parses it
 * (`useAtRound`), so an invalid value means live here too.
 */
export function isTimeTravelling(): boolean {
  if (typeof window === 'undefined') return false
  return parseRound(new URLSearchParams(window.location.search).get('round')) !== undefined
}

/** Throws {@link ReadOnlyError} while time travelling. Called before building any signing client. */
export function assertWritable(): void {
  if (isTimeTravelling()) {
    throw new ReadOnlyError()
  }
}

export function getStakingPoolFactory(): [AlgorandClient, StakingPoolFactory] {
  assertWritable()
  return [algorandClient, new StakingPoolFactory({ algorand: algorandClient })]
}

export async function getValidatorClient(
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<ValidatorRegistryClient> {
  assertWritable()
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(ValidatorRegistryClient, {
    defaultSender: activeAddress,
    appId: RETI_APP_ID,
  })
}

export async function getSimulateValidatorClient(
  senderAddr: string = FEE_SINK,
): Promise<ValidatorRegistryClient> {
  return algorandClient.client.getTypedAppClientById(ValidatorRegistryClient, {
    defaultSender: senderAddr,
    appId: RETI_APP_ID,
  })
}

export async function getStakingPoolClient(
  poolAppId: bigint,
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<StakingPoolClient> {
  assertWritable()
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(StakingPoolClient, {
    defaultSender: activeAddress,
    appId: poolAppId,
  })
}

export async function getSimulateStakingPoolClient(
  poolAppId: bigint,
  senderAddr: string = FEE_SINK,
): Promise<StakingPoolClient> {
  return algorandClient.client.getTypedAppClientById(StakingPoolClient, {
    defaultSender: senderAddr,
    appId: poolAppId,
  })
}

export async function getXGovRegistryClient(
  signer: algosdk.TransactionSigner,
  activeAddress: string,
): Promise<XGovRegistryClient> {
  assertWritable()
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(XGovRegistryClient, {
    defaultSender: activeAddress,
    appId: XGOV_REGISTRY_APP_ID,
  })
}

export async function getSimulateXGovRegistryClient(
  senderAddr: string = FEE_SINK,
): Promise<XGovRegistryClient> {
  return algorandClient.client.getTypedAppClientById(XGovRegistryClient, {
    defaultSender: senderAddr,
    appId: XGOV_REGISTRY_APP_ID,
  })
}
