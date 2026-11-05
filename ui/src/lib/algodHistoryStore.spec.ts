import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushAlgodHistories,
  restoreAlgodHistories,
  saveAlgodHistory,
} from '@/lib/algodHistoryStore'

const change = (round: bigint, algodVer: string) => ({ round, timestamp: Number(round), algodVer })

const DAY = 1000 * 60 * 60 * 24

// The store keeps module state, so each test uses its own registry id

describe('algodHistoryStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps each pool's history per registry, bigints and all", async () => {
    saveAlgodHistory(1n, 10n, { to: 500n, changes: [change(5n, 'a')] })
    saveAlgodHistory(1n, 11n, { to: 600n, changes: [] })
    saveAlgodHistory(2n, 10n, { to: 700n, changes: [change(7n, 'b')] })
    await flushAlgodHistories()

    const kept = await restoreAlgodHistories(1n)
    expect([...kept.keys()].sort()).toEqual([10n, 11n])
    expect(kept.get(10n)).toMatchObject({ to: 500n, changes: [change(5n, 'a')] })
    expect((await restoreAlgodHistories(2n)).get(10n)).toMatchObject({ to: 700n })
  })

  it('writes a history that gained changes', async () => {
    saveAlgodHistory(3n, 10n, { to: 100n, changes: [] })
    saveAlgodHistory(3n, 10n, { to: 200n, changes: [change(150n, 'c')] })
    await flushAlgodHistories()
    expect((await restoreAlgodHistories(3n)).get(10n)).toMatchObject({
      to: 200n,
      changes: [change(150n, 'c')],
    })
  })

  it('skips a listing that found nothing new, until its record is a day old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    saveAlgodHistory(4n, 10n, { to: 100n, changes: [] })
    await flushAlgodHistories()

    vi.setSystemTime(DAY - 1)
    saveAlgodHistory(4n, 10n, { to: 200n, changes: [] })
    await flushAlgodHistories()
    expect((await restoreAlgodHistories(4n)).get(10n)).toMatchObject({ to: 100n, savedAt: 0 })

    vi.setSystemTime(DAY)
    saveAlgodHistory(4n, 10n, { to: 300n, changes: [] })
    await flushAlgodHistories()
    expect((await restoreAlgodHistories(4n)).get(10n)).toMatchObject({ to: 300n, savedAt: DAY })
  })

  it('drops records not written for 30 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    saveAlgodHistory(5n, 10n, { to: 100n, changes: [] })
    await flushAlgodHistories()
    vi.setSystemTime(31 * DAY)
    expect((await restoreAlgodHistories(5n)).size).toBe(0)
  })
})
