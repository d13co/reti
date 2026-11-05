import {
  algodBuild,
  AlgodVersion,
  compareAlgodVersions,
  parseAlgodVersion,
} from '@/utils/algodVersion'

/** The time windows the upgrades page shows, back from the time on screen. */
export type UpgradeWindow = '1mo' | '3mo' | '1y' | 'all'

export const UPGRADE_WINDOWS: { value: UpgradeWindow; label: string }[] = [
  { value: '1mo', label: '1 month' },
  { value: '3mo', label: '3 months' },
  { value: '1y', label: '1 year' },
  { value: 'all', label: 'All time' },
]

const WINDOW_DAYS: Record<Exclude<UpgradeWindow, 'all'>, number> = {
  '1mo': 30,
  '3mo': 91,
  '1y': 365,
}

const DAY = 60 * 60 * 24

/** When a window starts (seconds): its length back from `anchorTime`, never before `earliest`. */
export function windowStartTime(window: UpgradeWindow, anchorTime: number, earliest = 0): number {
  if (window === 'all') return earliest
  return Math.max(earliest, anchorTime - WINDOW_DAYS[window] * DAY)
}

/** A pool's `algodVer` as of the end of `round`, the round its node daemon wrote it. */
export interface AlgodVerChange {
  round: bigint
  /** The round's block timestamp, in seconds */
  timestamp: number
  algodVer: string
}

/** What one pool reported over the scanned rounds. */
export interface PoolVersionHistory {
  poolAppId: bigint
  validatorId: number
  /** The node the pool is assigned to now; it may have been on another before */
  node?: number
  /** Its stake at the round on screen, in microalgos */
  stake?: bigint
  /** Its version before the first scanned round: empty if it had none, or didn't exist */
  base: string
  /** Its changes over the scanned rounds, oldest first */
  changes: AlgodVerChange[]
}

/**
 * One node's switch to a new version: the changes its pools reported close together, each within
 * {@link UPGRADE_GROUP_SECONDS} of the one before.
 */
export interface NodeUpgrade {
  validatorId: number
  node?: number
  /** The first change */
  round: bigint
  timestamp: number
  /** The last change */
  endTimestamp: number
  /** How many changes its pools reported */
  changes: number
  /** A pool went back to a version it had earlier in it, e.g. two nodes reporting for one pool */
  flapping: boolean
  pools: bigint[]
  /** What the pools reported before, oldest first; empty for pools reporting for the first time */
  from: AlgodVersion[]
  /** What the last change reported */
  to: AlgodVersion
}

/** A node's changes this close together are one upgrade. */
export const UPGRADE_GROUP_SECONDS = 6 * 60 * 60

/** The version a pool had at the end of `round`, from its history; empty if none. */
export function versionAt(pool: PoolVersionHistory, round: bigint): string {
  let version = pool.base
  for (const change of pool.changes) {
    if (change.round > round) break
    version = change.algodVer
  }
  return version
}

/** The version a pool had at `time` (seconds), from its history; empty if none. */
function versionAtTime(pool: PoolVersionHistory, time: number): string {
  let version = pool.base
  for (const change of pool.changes) {
    if (change.timestamp >= time) break
    version = change.algodVer
  }
  return version
}

interface PoolChange {
  pool: PoolVersionHistory
  round: bigint
  timestamp: number
  from: string
  to: string
}

/**
 * Each pool's changes from `fromTime` up to `toRound`, with what it had before each. A version
 * removed (empty) isn't a change of its own unless `removals` is set; without it, a change is
 * measured from the last version the pool reported, so reporting it again is no change.
 */
function poolChanges(
  pools: PoolVersionHistory[],
  fromTime: number,
  toRound: bigint,
  removals = false,
): PoolChange[] {
  const changes: PoolChange[] = []
  for (const pool of pools) {
    let previous = pool.base
    for (const change of pool.changes) {
      if (change.round > toRound) break
      const to = change.algodVer
      if (!removals && !to) continue
      if (change.timestamp >= fromTime && to !== previous) {
        changes.push({ pool, round: change.round, timestamp: change.timestamp, from: previous, to })
      }
      previous = to
    }
  }
  return changes
}

function distinctVersions(fulls: string[]): AlgodVersion[] {
  return [...new Set(fulls.filter(Boolean))].map(parseAlgodVersion).sort(compareAlgodVersions)
}

/**
 * The node upgrades from `fromTime` up to `toRound`, newest first. A node daemon writes its
 * version to each of its pools, so the changes one validator's node reports within
 * {@link UPGRADE_GROUP_SECONDS} of each other are one upgrade, whatever versions they report.
 */
export function nodeUpgrades(
  pools: PoolVersionHistory[],
  fromTime: number,
  toRound: bigint,
): NodeUpgrade[] {
  const changes = poolChanges(pools, fromTime, toRound).sort(
    (a, b) => a.pool.validatorId - b.pool.validatorId || Number(a.round - b.round),
  )
  const upgrades: NodeUpgrade[] = []
  // What each upgrade's pools reported before their first change in it
  const fromOf = new Map<NodeUpgrade, string[]>()
  // The latest upgrade of each validator's node, which the next change may still join, with the
  // versions each of its pools has had in it
  const open = new Map<
    string,
    { upgrade: NodeUpgrade; last: number; seen: Map<bigint, Set<string>> }
  >()
  for (const change of changes) {
    const key = `${change.pool.validatorId}:${change.pool.node ?? '-'}`
    const group = open.get(key)
    if (group && change.timestamp - group.last <= UPGRADE_GROUP_SECONDS) {
      const { upgrade } = group
      const seen = group.seen.get(change.pool.poolAppId)
      if (seen) {
        if (seen.has(change.to)) upgrade.flapping = true
        seen.add(change.to)
      } else {
        group.seen.set(change.pool.poolAppId, new Set([change.from, change.to]))
        upgrade.pools.push(change.pool.poolAppId)
        fromOf.get(upgrade)?.push(change.from)
      }
      upgrade.to = parseAlgodVersion(change.to)
      upgrade.changes++
      upgrade.endTimestamp = change.timestamp
      group.last = change.timestamp
      continue
    }
    const upgrade: NodeUpgrade = {
      validatorId: change.pool.validatorId,
      node: change.pool.node,
      round: change.round,
      timestamp: change.timestamp,
      endTimestamp: change.timestamp,
      changes: 1,
      flapping: false,
      pools: [change.pool.poolAppId],
      from: [],
      to: parseAlgodVersion(change.to),
    }
    fromOf.set(upgrade, [change.from])
    open.set(key, {
      upgrade,
      last: change.timestamp,
      seen: new Map([[change.pool.poolAppId, new Set([change.from, change.to])]]),
    })
    upgrades.push(upgrade)
  }
  for (const upgrade of upgrades) upgrade.from = distinctVersions(fromOf.get(upgrade) ?? [])
  return upgrades.sort((a, b) => b.timestamp - a.timestamp || Number(b.round - a.round))
}

/**
 * How an upgrade changed its node:
 * - upgrade / downgrade: to a newer / older algod release than any its pools had
 * - nodemgr: algod unchanged, only the node daemon
 * - other: algod changed but not up or down overall, e.g. another build of the same release, or
 *   pools coming from releases on both sides of the new one
 * - first: its pools hadn't reported before
 * - flapping: a pool went back and forth between versions
 */
export type UpgradeKind = 'upgrade' | 'downgrade' | 'nodemgr' | 'other' | 'first' | 'flapping'

export function upgradeKind(upgrade: NodeUpgrade): UpgradeKind {
  if (upgrade.flapping) return 'flapping'
  const oldest = upgrade.from[0]
  if (!oldest) return 'first'
  const newest = upgrade.from[upgrade.from.length - 1]
  const build = algodBuild(upgrade.to)
  if (upgrade.from.every((version) => algodBuild(version) === build)) return 'nodemgr'
  const vsNewest = compareAlgodVersions(upgrade.to, newest)
  const vsOldest = compareAlgodVersions(upgrade.to, oldest)
  if (vsNewest >= 0 && vsOldest > 0) return 'upgrade'
  if (vsOldest <= 0 && vsNewest < 0) return 'downgrade'
  return 'other'
}

/** A stretch of time over which a validator's oldest pool version stayed the same. */
export interface LaneSegment {
  start: number
  end: number
  /** Undefined while none of its pools had reported a version */
  version?: AlgodVersion
}

/** One of a validator's pools as it stood at the end of the window. */
export interface LanePool {
  poolAppId: bigint
  node?: number
  stake?: bigint
  /** Undefined if it hasn't reported a version */
  version?: AlgodVersion
}

/** One validator's lane: its oldest pool version over the window, and its upgrades. */
export interface ValidatorLane {
  validatorId: number
  segments: LaneSegment[]
  upgrades: NodeUpgrade[]
  /** Its oldest pool version at the end of the window */
  current?: AlgodVersion
  /** Its pools, by node */
  pools: LanePool[]
}

function oldestOf(versions: Iterable<string>): AlgodVersion | undefined {
  let oldest: AlgodVersion | undefined
  for (const full of versions) {
    if (!full) continue
    const version = parseAlgodVersion(full)
    if (!oldest || compareAlgodVersions(version, oldest) < 0) oldest = version
  }
  return oldest
}

/**
 * About as many segments as a lane can show apart. A lane is a few hundred pixels wide, and two
 * nodes reporting for one pool can flip its version every minute for weeks: tens of thousands of
 * segments that can't be seen, only rendered.
 */
export const MAX_LANE_SEGMENTS = 300

/** The older of two versions. */
function olderOf(a: AlgodVersion, b: AlgodVersion): AlgodVersion {
  return compareAlgodVersions(b, a) < 0 ? b : a
}

/**
 * Merges each run of segments shorter than `minLength` (seconds) into one, on the oldest version
 * among them, as the lane shows the oldest version among its pools. A run doesn't cross from none
 * reported to reported, so a lane never shows a version before its pools reported one. Longer
 * segments and the last one, the version the lane ends on, stay as they are. Neighbours left on
 * the same version are joined.
 */
export function boundSegments(segments: LaneSegment[], minLength: number): LaneSegment[] {
  const merged: LaneSegment[] = []
  let run: LaneSegment | undefined
  segments.forEach((segment, i) => {
    const short = segment.end - segment.start < minLength && i < segments.length - 1
    if (short && run && Boolean(run.version) === Boolean(segment.version)) {
      const version = run.version && segment.version && olderOf(run.version, segment.version)
      run = { start: run.start, end: segment.end, version }
      return
    }
    if (run) merged.push(run)
    run = undefined
    if (short) {
      run = { ...segment }
      return
    }
    merged.push(segment)
  })
  const joined: LaneSegment[] = []
  for (const segment of merged) {
    const previous = joined[joined.length - 1]
    if (previous && previous.version?.full === segment.version?.full) {
      joined[joined.length - 1] = { ...previous, end: segment.end }
    } else {
      joined.push(segment)
    }
  }
  return joined
}

/**
 * Each validator's lane from `fromTime` to `toTime` (up to `toRound`): the oldest version among
 * its pools as it changed, and the upgrades that changed it. Validators whose pools never
 * reported a version are left out.
 */
export function validatorLanes(
  pools: PoolVersionHistory[],
  upgrades: NodeUpgrade[],
  fromTime: number,
  toTime: number,
  toRound: bigint,
): ValidatorLane[] {
  const byValidator = new Map<number, PoolVersionHistory[]>()
  for (const pool of pools) {
    byValidator.set(pool.validatorId, [...(byValidator.get(pool.validatorId) ?? []), pool])
  }
  const upgradesByValidator = new Map<number, NodeUpgrade[]>()
  for (const upgrade of upgrades) {
    const list = upgradesByValidator.get(upgrade.validatorId) ?? []
    list.push(upgrade)
    upgradesByValidator.set(upgrade.validatorId, list)
  }

  const lanes: ValidatorLane[] = []
  for (const [validatorId, validatorPools] of byValidator) {
    const state = new Map(validatorPools.map((pool) => [pool, versionAtTime(pool, fromTime)]))
    const changes = poolChanges(validatorPools, fromTime, toRound, true).sort(
      (a, b) => a.timestamp - b.timestamp || Number(a.round - b.round),
    )
    const segments: LaneSegment[] = []
    let segment: LaneSegment = { start: fromTime, end: toTime, version: oldestOf(state.values()) }
    for (const change of changes) {
      state.set(change.pool, change.to)
      const oldest = oldestOf(state.values())
      if (oldest?.full === segment.version?.full) continue
      // A block timestamp past `toTime` (the round on screen, or a clock running behind) ends
      // the window
      const at = Math.min(change.timestamp, toTime)
      segments.push({ ...segment, end: at })
      segment = { start: at, end: toTime, version: oldest }
    }
    segments.push(segment)
    const current = segment.version
    if (!current && segments.every((s) => !s.version)) continue
    lanes.push({
      validatorId,
      segments: boundSegments(
        // The last segment stays even if it only just began: it is the version the lane ends on
        segments.filter((s, i) => s.end > s.start || i === segments.length - 1),
        (toTime - fromTime) / MAX_LANE_SEGMENTS,
      ),
      upgrades: upgradesByValidator.get(validatorId) ?? [],
      current,
      pools: validatorPools
        .map((pool) => {
          const version = versionAt(pool, toRound)
          return {
            poolAppId: pool.poolAppId,
            node: pool.node,
            stake: pool.stake,
            version: version ? parseAlgodVersion(version) : undefined,
          }
        })
        .sort(
          (a, b) =>
            (a.node ?? Infinity) - (b.node ?? Infinity) || Number(a.poolAppId - b.poolAppId),
        ),
    })
  }
  return lanes
}

/** A release's colour in each theme. */
export interface ReleaseColor {
  light: string
  dark: string
  /** The newest release on screen, which stands apart from the older ones */
  latest: boolean
}

/**
 * The newest release takes its own hue. The older ones share one hue as a ramp, so their order
 * reads as older to newer: the oldest is the lightest in light mode and the dimmest in dark mode.
 * Each end of the ramp is clear of the newest release's hue with any colour vision.
 */
const LATEST = { light: '#169a6b', dark: '#1f9e70' }
const OLDER_RAMP = {
  light: { oldest: '#6fa6ea', newest: '#1d4f91' },
  dark: { oldest: '#2f6bc0', newest: '#8db5ec' },
}

/** The algod releases on screen, oldest first, each with its colour. The last is the newest. */
export function releaseColors(releases: string[]): Map<string, ReleaseColor> {
  const sorted = [...new Set(releases)]
    .map((release) => parseAlgodVersion(release))
    .sort(compareAlgodVersions)
    .map((version) => version.release)
  const colors = new Map<string, ReleaseColor>()
  const latest = sorted.length - 1
  const lastOlder = latest - 1
  sorted.forEach((release, i) => {
    if (i === latest) {
      colors.set(release, { ...LATEST, latest: true })
      return
    }
    const newness = lastOlder <= 0 ? 100 : Math.round((i / lastOlder) * 100)
    const mix = (ends: { oldest: string; newest: string }) =>
      `color-mix(in oklab, ${ends.newest} ${newness}%, ${ends.oldest})`
    colors.set(release, { light: mix(OLDER_RAMP.light), dark: mix(OLDER_RAMP.dark), latest: false })
  })
  return colors
}

/**
 * When a validator's lane last moved onto `release` and stayed: the start of its run of
 * segments on it at the end of the window. The window's start if it was already on it then;
 * undefined if it isn't on it at the end.
 */
export function adoptedAt(lane: ValidatorLane, release: string): number | undefined {
  let adopted: number | undefined
  for (let i = lane.segments.length - 1; i >= 0; i--) {
    const segment = lane.segments[i]
    if (segment.version?.release !== release) break
    adopted = segment.start
  }
  return adopted
}

/**
 * When each release was first reached by any lane: the earliest start of a segment on it. The
 * window's start for a release some lane was already on then.
 */
export function firstReached(lanes: ValidatorLane[]): Map<string, number> {
  const first = new Map<string, number>()
  for (const lane of lanes) {
    for (const segment of lane.segments) {
      const release = segment.version?.release
      if (release === undefined) continue
      const known = first.get(release)
      if (known === undefined || segment.start < known) first.set(release, segment.start)
    }
  }
  return first
}

/** Whether `release` is older than `latest`. A release that didn't parse counts as older. */
export function isBehind(release: string | undefined, latest: string | undefined): boolean {
  if (release === undefined || latest === undefined) return false
  return compareAlgodVersions(parseAlgodVersion(release), parseAlgodVersion(latest)) < 0
}

/**
 * The releases the lanes show, oldest first: those of their segments, and those their pools
 * are on at the end of the window. A release some pools run before any validator is wholly on it
 * counts, so it is the latest as soon as it rolls out.
 */
export function laneReleases(lanes: ValidatorLane[]): string[] {
  const releases = new Set<string>()
  for (const lane of lanes) {
    for (const segment of lane.segments) if (segment.version) releases.add(segment.version.release)
    for (const pool of lane.pools) if (pool.version) releases.add(pool.version.release)
  }
  return [...releases]
}

/** How the lanes are ordered. */
export type LaneSort = 'stake' | 'behind' | 'adoption'

export const LANE_SORTS: { value: LaneSort; label: string }[] = [
  { value: 'stake', label: 'Stake' },
  { value: 'behind', label: 'Furthest behind' },
  { value: 'adoption', label: 'Adoption speed' },
]

/**
 * When a validator's lane last reached `release` or a newer one and stayed: the start of its run
 * of segments at or past it at the end of the window. The window's start if it was already there
 * then; undefined if it is behind `release` at the end.
 */
export function reachedAt(lane: ValidatorLane, release: string): number | undefined {
  const target = parseAlgodVersion(release)
  let reached: number | undefined
  for (let i = lane.segments.length - 1; i >= 0; i--) {
    const version = lane.segments[i].version
    if (!version || compareAlgodVersions(version, target) < 0) break
    reached = lane.segments[i].start
  }
  return reached
}

/**
 * The lanes in `sort` order, ties by stake (most first), then validator id:
 * - stake: most first
 * - behind: oldest current release first
 * - adoption: newest current release first, then who moved onto it earliest
 *
 * With a `release` picked, both measure against it instead:
 * - behind: those not on it yet first, as with no release picked; then those on it or past it,
 *   who reached it latest first
 * - adoption: those on it or past it first, who reached it earliest first; then those not on it
 *   yet, as with no release picked
 *
 * Validators with no current release go last.
 */
export function sortLanes(
  lanes: ValidatorLane[],
  sort: LaneSort,
  stakes: Map<number, bigint>,
  release?: string,
): ValidatorLane[] {
  const byStake = (a: ValidatorLane, b: ValidatorLane) => {
    const stakeA = stakes.get(a.validatorId) ?? 0n
    const stakeB = stakes.get(b.validatorId) ?? 0n
    if (stakeA !== stakeB) return stakeA > stakeB ? -1 : 1
    return a.validatorId - b.validatorId
  }
  if (sort === 'stake') return [...lanes].sort(byStake)
  // When each lane moved onto the release it's on
  const adopted = new Map(
    lanes.map((lane) => [lane, lane.current ? adoptedAt(lane, lane.current.release) : undefined]),
  )
  // By current release, as `sort` orders lanes with no release picked
  const byCurrent = (a: ValidatorLane, b: ValidatorLane, va: AlgodVersion, vb: AlgodVersion) => {
    if (sort === 'behind') return compareAlgodVersions(va, vb) || byStake(a, b)
    const newer = compareAlgodVersions(vb, va)
    if (newer !== 0) return newer
    const timeA = adopted.get(a) ?? Infinity
    const timeB = adopted.get(b) ?? Infinity
    return timeA !== timeB ? timeA - timeB : byStake(a, b)
  }
  // When each lane reached the picked release or a newer one
  const reached =
    release === undefined
      ? undefined
      : new Map(lanes.map((lane) => [lane, reachedAt(lane, release)]))
  return [...lanes].sort((a, b) => {
    if (!a.current || !b.current) {
      return a.current ? -1 : b.current ? 1 : byStake(a, b)
    }
    if (!reached) return byCurrent(a, b, a.current, b.current)
    const timeA = reached.get(a)
    const timeB = reached.get(b)
    if ((timeA === undefined) !== (timeB === undefined)) {
      return (timeA === undefined) === (sort === 'behind') ? -1 : 1
    }
    // Neither has reached it: the order without a pick
    if (timeA === undefined || timeB === undefined) return byCurrent(a, b, a.current, b.current)
    if (timeA === timeB) return byStake(a, b)
    return sort === 'behind' ? timeB - timeA : timeA - timeB
  })
}
