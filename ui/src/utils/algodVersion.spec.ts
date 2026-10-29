import { describe, expect, it } from 'vitest'
import { LocalPoolInfo, PoolGlobalState } from '@/interfaces/validator'
import {
  compareAlgodVersions,
  eligibleAlgodVersions,
  oldestAlgodVersion,
  parseAlgodVersion,
} from '@/utils/algodVersion'

const ALGO = 1_000_000n

function poolState(algodVer: string | undefined, balance: bigint): PoolGlobalState {
  return { algodVer, balance, minBalance: 0n, apy: 0 }
}

function pool(poolAppId: bigint): LocalPoolInfo {
  return { poolId: 0n, poolAppId, totalStakers: 0, totalAlgoStaked: 0n }
}

describe('parseAlgodVersion', () => {
  it('takes the release from the start of the node daemon string', () => {
    const full = '3.23.1 rel/stable [34171a94] : v0.8.2 [c58270f]'
    expect(parseAlgodVersion(full)).toEqual({ release: '3.23.1', full, parts: [3, 23, 1] })
  })

  it('keeps a string that does not start with a release whole', () => {
    expect(parseAlgodVersion('dev build')).toEqual({ release: 'dev build', full: 'dev build' })
  })
})

describe('compareAlgodVersions', () => {
  const v = (full: string) => parseAlgodVersion(full)

  it('compares numerically, not as text', () => {
    expect(compareAlgodVersions(v('3.9.0'), v('3.23.1'))).toBeLessThan(0)
    expect(compareAlgodVersions(v('4.0.0'), v('3.99.9'))).toBeGreaterThan(0)
    expect(compareAlgodVersions(v('3.23.1 a'), v('3.23.1 b'))).toBe(0)
  })

  it('sorts an unparsed version first', () => {
    expect(compareAlgodVersions(v('dev'), v('1.0.0'))).toBeLessThan(0)
    expect(compareAlgodVersions(v('1.0.0'), v('dev'))).toBeGreaterThan(0)
  })
})

describe('eligibleAlgodVersions', () => {
  it('keeps the reported versions of pools holding at least 30k ALGO', () => {
    expect(
      eligibleAlgodVersions({
        '1': poolState('3.23.1', 30_000n * ALGO),
        '2': poolState('3.20.0', 29_999n * ALGO),
        '3': poolState(undefined, 100_000n * ALGO),
      }),
    ).toEqual({ '1': '3.23.1' })
  })
})

describe('oldestAlgodVersion', () => {
  it("picks the oldest of the validator's listed pools", () => {
    const versions = { '1': '3.23.1 x', '2': '3.9.2 y', '9': '1.0.0' }
    expect(oldestAlgodVersion([pool(1n), pool(2n), pool(3n)], versions)?.full).toBe('3.9.2 y')
  })

  it('is undefined when none of its pools is listed', () => {
    expect(oldestAlgodVersion([pool(3n)], { '1': '3.23.1' })).toBeUndefined()
  })
})
