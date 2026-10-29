import { LocalPoolInfo, PoolGlobalStates } from '@/interfaces/validator'
import { MIN_ELIGIBLE_STAKE } from '@/utils/table'

/** A pool's reported algod version, as the node daemon writes it. */
export interface AlgodVersion {
  /** The algod release, e.g. `3.23.1`, or the whole string if it doesn't start with one */
  release: string
  /** Everything the node daemon wrote: algod's full version, then its own */
  full: string
  /** The release's major, minor and patch numbers; undefined if it didn't parse */
  parts?: [number, number, number]
}

/**
 * Parses a pool's `algodVer`, which the node daemon writes as algod's version string and then
 * its own, e.g. `3.23.1 rel/stable [34171a94] : v0.8.2 [c58270f]`.
 */
export function parseAlgodVersion(full: string): AlgodVersion {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(full)
  if (!match) return { release: full.trim(), full }
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return { release: parts.join('.'), full, parts }
}

/** Orders versions oldest first. A version that didn't parse sorts before every one that did. */
export function compareAlgodVersions(a: AlgodVersion, b: AlgodVersion): number {
  if (!a.parts || !b.parts) {
    if (!a.parts && !b.parts) return a.full.localeCompare(b.full)
    return a.parts ? 1 : -1
  }
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i]
  }
  return 0
}

/** Each pool's reported algod version, keyed by pool app id. */
export type PoolAlgodVersions = Readonly<Record<string, string>>

/**
 * The reported algod versions of the pools eligible for consensus rewards (holding at least 30k
 * ALGO). Pools whose node daemon has never reported a version are left out.
 */
export function eligibleAlgodVersions(poolGlobalStates: PoolGlobalStates): PoolAlgodVersions {
  const versions: Record<string, string> = {}
  for (const [poolAppId, state] of Object.entries(poolGlobalStates)) {
    if (state.algodVer && state.balance >= MIN_ELIGIBLE_STAKE) versions[poolAppId] = state.algodVer
  }
  return versions
}

/** The oldest of the listed versions among a validator's pools; undefined if none is listed. */
export function oldestAlgodVersion(
  pools: LocalPoolInfo[],
  versions: PoolAlgodVersions,
): AlgodVersion | undefined {
  let oldest: AlgodVersion | undefined
  for (const pool of pools) {
    const full = versions[String(pool.poolAppId)]
    if (!full) continue
    const version = parseAlgodVersion(full)
    if (!oldest || compareAlgodVersions(version, oldest) < 0) oldest = version
  }
  return oldest
}

/** The node daemon's own version, after algod's in the string it writes (e.g. `v1.5.1`). */
export function nodemgrVersion(version: AlgodVersion): string | undefined {
  return /:\s*(v?\d+\.\d+\.\d+)/.exec(version.full)?.[1]
}

/** algod's own part of the string, release and build, without the node daemon's version. */
export function algodBuild(version: AlgodVersion): string {
  return version.full.split(/\s+:\s+/)[0].trim()
}
