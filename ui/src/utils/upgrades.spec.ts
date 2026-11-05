import { describe, expect, it } from 'vitest'
import { parseAlgodVersion } from '@/utils/algodVersion'
import {
  adoptedAt,
  boundSegments,
  firstReached,
  isBehind,
  laneReleases,
  LaneSegment,
  MAX_LANE_SEGMENTS,
  nodeUpgrades,
  PoolVersionHistory,
  reachedAt,
  releaseColors,
  sortLanes,
  upgradeKind,
  validatorLanes,
  versionAt,
  windowStartTime,
} from '@/utils/upgrades'

const V = (release: string, daemon = 'v1.5.1') => `${release} rel/stable [abc] : ${daemon} [def]`
const HOUR = 60 * 60
const DAY = 24 * HOUR

function pool(
  poolAppId: bigint,
  validatorId: number,
  node: number | undefined,
  base: string,
  changes: [round: number, timestamp: number, release: string][],
): PoolVersionHistory {
  return {
    poolAppId,
    validatorId,
    node,
    base,
    changes: changes.map(([round, timestamp, algodVer]) => ({
      round: BigInt(round),
      timestamp,
      algodVer,
    })),
  }
}

describe('windows', () => {
  it('starts a window its length back, never before the earliest time', () => {
    expect(windowStartTime('1mo', 100 * DAY)).toBe(70 * DAY)
    expect(windowStartTime('1y', 100 * DAY, 10 * DAY)).toBe(10 * DAY)
    expect(windowStartTime('all', 100 * DAY, 10 * DAY)).toBe(10 * DAY)
  })
})

describe('nodeUpgrades', () => {
  it("groups a node's pools moving to one version close together", () => {
    const pools = [
      pool(1n, 7, 1, V('5.0.3'), [[100, 10 * DAY, V('5.0.4')]]),
      pool(2n, 7, 1, V('5.0.2'), [[102, 10 * DAY + HOUR, V('5.0.4')]]),
      // Another node of the same validator: its own upgrade
      pool(3n, 7, 2, V('5.0.3'), [[150, 10 * DAY + 2 * HOUR, V('5.0.4')]]),
    ]
    const upgrades = nodeUpgrades(pools, 0, 1000n)
    expect(upgrades).toHaveLength(2)
    const [node2, node1] = upgrades
    expect(node2).toMatchObject({ node: 2, pools: [3n], round: 150n })
    expect(node1).toMatchObject({ node: 1, pools: [1n, 2n], round: 100n })
    expect(node1.from.map((v) => v.release)).toEqual(['5.0.2', '5.0.3'])
    expect(node1.to.release).toBe('5.0.4')
  })

  it('splits changes to the same version far apart', () => {
    const pools = [
      pool(1n, 7, 1, V('5.0.3'), [[100, DAY, V('5.0.4')]]),
      pool(2n, 7, 1, V('5.0.3'), [[900, 5 * DAY, V('5.0.4')]]),
    ]
    expect(nodeUpgrades(pools, 0, 1000n)).toHaveLength(2)
  })

  it('keeps only changes in the window, with what came before as their start', () => {
    const p = pool(1n, 7, 1, V('5.0.1'), [
      [100, DAY, V('5.0.2')],
      [200, 2 * DAY, V('5.0.3')],
      [300, 3 * DAY, V('5.0.4')],
    ])
    const upgrades = nodeUpgrades([p], 2 * DAY, 250n)
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0].from.map((v) => v.release)).toEqual(['5.0.2'])
    expect(upgrades[0].to.release).toBe('5.0.3')
  })

  it('folds a pool going back and forth into one flapping upgrade', () => {
    const upgrades = nodeUpgrades(
      [
        pool(1n, 7, 1, V('5.0.3'), [
          [100, DAY, V('5.0.4')],
          [110, DAY + HOUR, V('5.0.3')],
          [120, DAY + 2 * HOUR, V('5.0.4')],
        ]),
      ],
      0,
      1000n,
    )
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0]).toMatchObject({
      round: 100n,
      endTimestamp: DAY + 2 * HOUR,
      changes: 3,
      flapping: true,
      pools: [1n],
    })
    expect(upgradeKind(upgrades[0])).toBe('flapping')
  })

  it('keeps steps through several versions as one upgrade', () => {
    const [upgrade] = nodeUpgrades(
      [
        pool(1n, 7, 1, V('5.0.2'), [
          [100, DAY, V('5.0.3')],
          [110, DAY + HOUR, V('5.0.4')],
        ]),
      ],
      0,
      1000n,
    )
    expect(upgrade).toMatchObject({ changes: 2, flapping: false })
    expect(upgrade.from.map((v) => v.release)).toEqual(['5.0.2'])
    expect(upgradeKind(upgrade)).toBe('upgrade')
  })

  it('tells upgrades, downgrades and node daemon updates apart', () => {
    const kind = (from: string[], to: string) =>
      upgradeKind({
        validatorId: 1,
        round: 1n,
        timestamp: 1,
        endTimestamp: 1,
        changes: 1,
        flapping: false,
        pools: [1n],
        from: from.map(parseAlgodVersion),
        to: parseAlgodVersion(to),
      })
    expect(kind([V('5.0.3')], V('5.0.4'))).toBe('upgrade')
    expect(kind([V('5.0.3'), V('5.0.4')], V('5.0.4'))).toBe('upgrade')
    expect(kind([V('5.0.4')], V('5.0.3'))).toBe('downgrade')
    expect(kind([V('5.0.4', 'v1.5.0')], V('5.0.4', 'v1.5.1'))).toBe('nodemgr')
    expect(kind([V('5.0.4')], '5.0.4 rel/stable [abc]')).toBe('nodemgr')
    // Another build of the same release, and pools from both sides of the new release
    expect(kind([V('5.0.4')], '5.0.4 rel/beta [fff] : v1.5.1 [def]')).toBe('other')
    expect(kind([V('5.0.3'), V('5.0.5')], V('5.0.4'))).toBe('other')
    expect(kind([], V('5.0.4'))).toBe('first')
  })
})

describe('validatorLanes', () => {
  it("follows the oldest of a validator's pools", () => {
    const pools = [
      pool(1n, 7, 1, V('5.0.2'), [[100, 10 * DAY, V('5.0.4')]]),
      pool(2n, 7, 2, V('5.0.3'), [[200, 20 * DAY, V('5.0.4')]]),
    ]
    const upgrades = nodeUpgrades(pools, 0, 1000n)
    const [lane] = validatorLanes(pools, upgrades, 0, 30 * DAY, 1000n)
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY, s.version?.release])).toEqual([
      [0, 10, '5.0.2'],
      [10, 20, '5.0.3'],
      [20, 30, '5.0.4'],
    ])
    expect(lane.current?.release).toBe('5.0.4')
    expect(lane.upgrades).toHaveLength(2)
    expect(lane.pools.map((p) => [p.poolAppId, p.node, p.version?.release])).toEqual([
      [1n, 1, '5.0.4'],
      [2n, 2, '5.0.4'],
    ])
  })

  it('keeps a last segment that only just began', () => {
    // The round on screen is the upgrade's own: its change lands at the window's end
    const pools = [pool(1n, 7, 1, V('5.0.3'), [[100, 10 * DAY, V('5.0.4')]])]
    const [lane] = validatorLanes(pools, [], 0, 10 * DAY, 100n)
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY, s.version?.release])).toEqual([
      [0, 10, '5.0.3'],
      [10, 10, '5.0.4'],
    ])
    expect(lane.current?.release).toBe('5.0.4')
    expect(adoptedAt(lane, '5.0.4')).toBe(10 * DAY)
  })

  it('ends the window at a change stamped after it', () => {
    const pools = [pool(1n, 7, 1, V('5.0.3'), [[100, 11 * DAY, V('5.0.4')]])]
    const [lane] = validatorLanes(pools, [], 0, 10 * DAY, 100n)
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY])).toEqual([
      [0, 10],
      [10, 10],
    ])
  })

  it('follows a pool whose version was removed, without making it an upgrade', () => {
    const pools = [
      pool(1n, 7, 1, V('5.0.4'), []),
      pool(2n, 7, 2, V('5.0.2'), [
        [100, 10 * DAY, ''],
        [200, 20 * DAY, V('5.0.2')],
      ]),
    ]
    const upgrades = nodeUpgrades(pools, 0, 1000n)
    // Reporting the same version again is no change
    expect(upgrades).toEqual([])
    const [lane] = validatorLanes(pools, upgrades, 0, 30 * DAY, 1000n)
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY, s.version?.release])).toEqual([
      [0, 10, '5.0.2'],
      [10, 20, '5.0.4'],
      [20, 30, '5.0.2'],
    ])
    const [removedOnly] = validatorLanes(pools, upgrades, 0, 15 * DAY, 150n)
    expect(removedOnly.current?.release).toBe('5.0.4')
    expect(removedOnly.pools.map((p) => p.version?.release)).toEqual(['5.0.4', undefined])
  })

  it('starts a pool created in the window with its first report', () => {
    const pools = [
      pool(1n, 7, 1, V('5.0.3'), []),
      pool(2n, 7, 2, '', [[100, 10 * DAY, V('5.0.2')]]),
    ]
    const upgrades = nodeUpgrades(pools, 0, 1000n)
    expect(upgrades.map(upgradeKind)).toEqual(['first'])
    const [lane] = validatorLanes(pools, upgrades, 0, 30 * DAY, 1000n)
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY, s.version?.release])).toEqual([
      [0, 10, '5.0.3'],
      [10, 30, '5.0.2'],
    ])
  })

  it('leaves out validators whose pools never reported', () => {
    expect(validatorLanes([pool(1n, 7, 1, '', [])], [], 0, DAY, 10n)).toEqual([])
  })

  it('bounds a flapping lane to what it can show', () => {
    // Two nodes reporting for one pool: its daemon flips every minute for 10 days, ending on the
    // one it started on
    const flips: [number, number, string][] = Array.from({ length: 10 * 24 * 60 + 1 }, (_, i) => [
      100 + i,
      5 * DAY + i * 60,
      V('5.0.4', i % 2 === 0 ? 'v1.0.0' : 'v1.0.3'),
    ])
    const pools = [pool(1n, 7, 1, V('5.0.3'), [...flips, [100_000, 20 * DAY, V('5.0.5')]])]
    const [lane] = validatorLanes(pools, [], 0, 30 * DAY, 200_000n)
    expect(lane.segments.length).toBeLessThanOrEqual(2 * MAX_LANE_SEGMENTS + 2)
    // The flips become one segment, between the versions either side
    expect(lane.segments.map((s) => [s.start / DAY, s.end / DAY, s.version?.full])).toEqual([
      [0, 5, V('5.0.3')],
      [5, 20, V('5.0.4', 'v1.0.0')],
      [20, 30, V('5.0.5')],
    ])
  })
})

describe('boundSegments', () => {
  const seg = (start: number, end: number, release?: string): LaneSegment => ({
    start,
    end,
    version: release ? parseAlgodVersion(V(release)) : undefined,
  })
  const shape = (segments: LaneSegment[]) =>
    segments.map((s) => [s.start, s.end, s.version?.release])

  it('merges a run of short segments into its oldest version', () => {
    const segments = [
      seg(0, 50, '5.0.2'),
      seg(50, 51, '5.0.4'),
      seg(51, 52, '5.0.3'),
      seg(52, 100, '5.0.5'),
    ]
    expect(shape(boundSegments(segments, 10))).toEqual([
      [0, 50, '5.0.2'],
      [50, 52, '5.0.3'],
      [52, 100, '5.0.5'],
    ])
  })

  it('keeps the last segment however short, and joins neighbours left on one version', () => {
    const segments = [
      seg(0, 50, '5.0.2'),
      seg(50, 51, '5.0.4'),
      seg(51, 52, '5.0.2'),
      seg(52, 53, '5.0.5'),
    ]
    expect(shape(boundSegments(segments, 10))).toEqual([
      [0, 52, '5.0.2'],
      [52, 53, '5.0.5'],
    ])
  })

  it('never merges none reported into a reported version', () => {
    const segments = [
      seg(0, 1),
      seg(1, 2),
      seg(2, 3, '5.0.4'),
      seg(3, 4, '5.0.3'),
      seg(4, 50, '5.0.5'),
    ]
    expect(shape(boundSegments(segments, 10))).toEqual([
      [0, 2, undefined],
      [2, 4, '5.0.3'],
      [4, 50, '5.0.5'],
    ])
  })

  it('leaves segments long enough alone', () => {
    const segments = [seg(0, 50, '5.0.2'), seg(50, 100, '5.0.4')]
    expect(boundSegments(segments, 10)).toEqual(segments)
  })
})

describe('versionAt', () => {
  it('reads the version in effect at a round', () => {
    const p = pool(1n, 1, 1, 'a', [[10, 1, 'b']])
    expect([versionAt(p, 9n), versionAt(p, 10n)]).toEqual(['a', 'b'])
  })
})

describe('releaseColors', () => {
  it('sets the newest release apart and ramps the older ones', () => {
    const colors = releaseColors(['5.0.4', '4.7.4', '5.0.0', '4.9.0', '5.0.4'])
    expect([...colors.keys()]).toEqual(['4.7.4', '4.9.0', '5.0.0', '5.0.4'])
    expect(colors.get('5.0.4')).toEqual({ light: '#169a6b', dark: '#1f9e70', latest: true })
    expect(colors.get('4.7.4')?.light).toBe('color-mix(in oklab, #1d4f91 0%, #6fa6ea)')
    expect(colors.get('4.9.0')?.light).toBe('color-mix(in oklab, #1d4f91 50%, #6fa6ea)')
    expect(colors.get('5.0.0')).toMatchObject({
      dark: 'color-mix(in oklab, #8db5ec 100%, #2f6bc0)',
      latest: false,
    })
  })

  it('gives a lone release the latest colour', () => {
    expect(releaseColors(['5.0.4']).get('5.0.4')?.latest).toBe(true)
  })
})

describe('adoption and lane order', () => {
  // Validator 1 moves to 5.0.4 on day 10, validator 2 on day 3, validator 3 never does,
  // validator 4 is already on it when the window starts, and validator 5 stays on 5.0.3
  const pools = [
    pool(1n, 1, 1, V('5.0.3'), [[100, 10 * DAY, V('5.0.4')]]),
    pool(2n, 2, 1, V('5.0.2'), [[30, 3 * DAY, V('5.0.4')]]),
    pool(3n, 3, 1, V('5.0.2'), []),
    pool(4n, 4, 1, V('5.0.4'), []),
    pool(5n, 5, 1, V('5.0.3'), []),
  ]
  const upgrades = nodeUpgrades(pools, 0, 1000n)
  const lanes = validatorLanes(pools, upgrades, 0, 30 * DAY, 1000n)
  const lane = (id: number) => lanes.find((l) => l.validatorId === id)!
  const stakes = new Map([
    [1, 10n],
    [2, 20n],
    [3, 40n],
    [4, 30n],
    [5, 5n],
  ])
  const order = (sort: Parameters<typeof sortLanes>[1]) =>
    sortLanes(lanes, sort, stakes).map((l) => l.validatorId)

  it('finds when a validator moved onto a release', () => {
    expect(adoptedAt(lane(1), '5.0.4')).toBe(10 * DAY)
    expect(adoptedAt(lane(4), '5.0.4')).toBe(0)
    expect(adoptedAt(lane(3), '5.0.4')).toBeUndefined()
  })

  it('sorts by stake, by how far behind, and by adoption', () => {
    expect(order('stake')).toEqual([3, 4, 2, 1, 5])
    expect(order('behind')).toEqual([3, 5, 4, 2, 1])
    // Newest release first, then who reached it earliest: those on 5.0.3 and 5.0.2 follow
    expect(order('adoption')).toEqual([4, 2, 1, 5, 3])
  })

  it('finds when a validator reached a release or a newer one', () => {
    expect(reachedAt(lane(1), '5.0.3')).toBe(0)
    expect(reachedAt(lane(1), '5.0.4')).toBe(10 * DAY)
    expect(reachedAt(lane(2), '5.0.3')).toBe(3 * DAY)
    expect(reachedAt(lane(3), '5.0.3')).toBeUndefined()
  })

  it('measures against a picked release', () => {
    const picked = (sort: Parameters<typeof sortLanes>[1], release: string) =>
      sortLanes(lanes, sort, stakes, release).map((l) => l.validatorId)
    // Not on 5.0.4 yet, oldest first; then who reached it latest
    expect(picked('behind', '5.0.4')).toEqual([3, 5, 1, 2, 4])
    // Who reached 5.0.4 earliest; then those not on it, newest first
    expect(picked('adoption', '5.0.4')).toEqual([4, 2, 1, 5, 3])
    // 1, 4 and 5 were at 5.0.3 or past it from the start, so stake breaks their tie
    expect(picked('behind', '5.0.3')).toEqual([3, 2, 4, 1, 5])
    expect(picked('adoption', '5.0.3')).toEqual([4, 1, 5, 2, 3])
    expect(picked('stake', '5.0.3')).toEqual(order('stake'))
  })

  it('orders those not on a picked release as with no pick', () => {
    // 1 and 2 are both on 5.0.3: 2 has more stake but moved onto it later. 3 is on 5.0.4. 4's
    // only pool stopped reporting, so it has no current release
    const pools = [
      pool(1n, 1, 1, V('5.0.3'), []),
      pool(2n, 2, 1, V('5.0.2'), [[50, 5 * DAY, V('5.0.3')]]),
      pool(3n, 3, 1, V('5.0.3'), [[80, 8 * DAY, V('5.0.4')]]),
      pool(4n, 4, 1, V('5.0.4'), [[20, 2 * DAY, '']]),
    ]
    const lanes = validatorLanes(pools, nodeUpgrades(pools, 0, 1000n), 0, 30 * DAY, 1000n)
    const stakes = new Map([
      [1, 10n],
      [2, 20n],
      [3, 5n],
      [4, 99n],
    ])
    const ids = (sort: Parameters<typeof sortLanes>[1], release?: string) =>
      sortLanes(lanes, sort, stakes, release).map((l) => l.validatorId)
    expect(ids('adoption')).toEqual([3, 1, 2, 4])
    // Picking the latest release changes nothing
    expect(ids('adoption', '5.0.4')).toEqual(ids('adoption'))
    expect(ids('behind', '5.0.4')).toEqual([2, 1, 3, 4])
    // No current release goes last whatever is picked
    expect(ids('adoption', '5.0.3')).toEqual([1, 3, 2, 4])
    // Everyone with a release has reached 5.0.3: 2 got there latest
    expect(ids('behind', '5.0.3')).toEqual([2, 1, 3, 4])
  })

  it('finds when each release was first reached', () => {
    expect(Object.fromEntries(firstReached(lanes))).toEqual({
      '5.0.2': 0,
      '5.0.3': 0,
      '5.0.4': 0,
    })
    expect(firstReached([lane(1), lane(2)]).get('5.0.4')).toBe(3 * DAY)
  })
})

describe('reaching a picked release', () => {
  const lanesOf = (pools: PoolVersionHistory[]) =>
    validatorLanes(pools, nodeUpgrades(pools, 0, 1000n), 0, 30 * DAY, 1000n)

  it('counts the run after a pool stopped reporting for a while', () => {
    const [lane] = lanesOf([
      pool(1n, 1, 1, V('5.0.3'), [
        [20, 2 * DAY, ''],
        [60, 6 * DAY, V('5.0.3')],
      ]),
    ])
    expect(reachedAt(lane, '5.0.3')).toBe(6 * DAY)
    expect(reachedAt(lane, '5.0.2')).toBe(6 * DAY)
  })

  it('leaves the order alone for a release only some pools run', () => {
    // Validator 1 has one pool on 5.0.4 and one on 5.0.3, so its lane is on 5.0.3
    const lanes = lanesOf([
      pool(1n, 1, 1, V('5.0.3'), [[100, 10 * DAY, V('5.0.4')]]),
      pool(2n, 1, 2, V('5.0.3'), []),
      pool(3n, 2, 1, V('5.0.2'), []),
    ])
    const stakes = new Map([
      [1, 10n],
      [2, 20n],
    ])
    for (const sort of ['behind', 'adoption'] as const) {
      expect(sortLanes(lanes, sort, stakes, '5.0.4')).toEqual(sortLanes(lanes, sort, stakes))
    }
  })

  it('counts every parsed release as past one that did not parse', () => {
    const lanes = lanesOf([pool(1n, 1, 1, V('5.0.3'), []), pool(2n, 2, 1, 'garbled', [])])
    expect(lanes.map((lane) => reachedAt(lane, 'garbled'))).toEqual([0, 0])
    expect(lanes.map((lane) => reachedAt(lane, '5.0.3'))).toEqual([0, undefined])
  })
})

describe('the latest release', () => {
  it('counts a release some pools run before any validator is wholly on it', () => {
    // Validator 1 has one pool on 5.0.4 and one on 5.0.3; validator 2 is on 5.0.3
    const pools = [
      pool(1n, 1, 1, V('5.0.3'), [[100, 10 * DAY, V('5.0.4')]]),
      pool(2n, 1, 2, V('5.0.3'), []),
      pool(3n, 2, 1, V('5.0.3'), []),
    ]
    const lanes = validatorLanes(pools, nodeUpgrades(pools, 0, 1000n), 0, 30 * DAY, 1000n)
    const releases = laneReleases(lanes)
    expect(releases.sort()).toEqual(['5.0.3', '5.0.4'])
    const latest = [...releaseColors(releases).keys()].pop()
    expect(latest).toBe('5.0.4')
    expect(lanes.map((lane) => isBehind(lane.current?.release, latest))).toEqual([true, true])
  })

  it('compares releases, not their names', () => {
    expect(isBehind('5.0.3', '5.0.4')).toBe(true)
    expect(isBehind('5.0.4', '5.0.4')).toBe(false)
    expect(isBehind('5.0.10', '5.0.4')).toBe(false)
    expect(isBehind('garbled', '5.0.4')).toBe(true)
    expect(isBehind(undefined, '5.0.4')).toBe(false)
    expect(isBehind('5.0.3', undefined)).toBe(false)
  })
})
