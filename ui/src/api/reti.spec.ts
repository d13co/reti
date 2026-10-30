/**
 * The read layer's module setup, against a fake `RetiGhostSDK` (the other specs replace this whole
 * module with `mockRetiModule()`). Each case loads a fresh copy of the module.
 */

import type { GhostkitNode } from 'reti-ghost-sdk'

const { DT_NODE_WITH_QUERIES } = vi.hoisted(() => ({
  DT_NODE_WITH_QUERIES: {
    kind: 'dt' as const,
    limits: {
      maxTxnGroups: 16,
      maxRounds: 256,
      maxExtraOpcodeBudget: 640_000,
      resourceLimitMultiplier: 128,
      timeTravel: true,
      developerApi: true,
    },
    query: {
      maxCalls: 1024,
      maxRounds: 16,
      maxCallBudget: 320_000,
      maxCallLogBytes: 65_536,
      maxCallStateBytes: 67_108_864,
      maxResponseBytes: 67_108_864,
    },
  },
}))

const fake = vi.hoisted(() => {
  const state = {
    /** The arguments of each `prefetch` call */
    prefetchCalls: [] as unknown[][],
    /** What `prefetch` returns */
    prefetchResult: (): Promise<void> => Promise.resolve(),
    sdk: {
      // Not a `vi.fn`: a spy handles the promises it returns, which would hide an unhandled rejection
      prefetch: (...args: unknown[]) => {
        state.prefetchCalls.push(args)
        return state.prefetchResult()
      },
      getChangeRounds: async () => ({
        changes: [{ round: 46_518_891n, timestamp: 1_736_000_000 }],
      }),
      supportsTimeTravel: vi.fn(async () => true),
      getNode: vi.fn(async (): Promise<GhostkitNode> => DT_NODE_WITH_QUERIES),
    },
  }
  return state
})

vi.mock('reti-ghost-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('reti-ghost-sdk')>()),
  // A regular function, so `new RetiGhostSDK(…)` returns the fake
  RetiGhostSDK: vi.fn(function () {
    return fake.sdk
  }),
}))

/** A fresh copy of `@/api/reti`, which runs its module-level setup again. */
async function loadReti() {
  vi.resetModules()
  return import('@/api/reti')
}

beforeEach(() => {
  fake.prefetchCalls = []
  fake.prefetchResult = () => Promise.resolve()
  fake.sdk.supportsTimeTravel.mockResolvedValue(true)
  fake.sdk.getNode.mockResolvedValue(DT_NODE_WITH_QUERIES)
})

describe('@/api/reti', () => {
  it('prefetches the read node and registry once, when the module loads', async () => {
    await loadReti()
    // At module load there is nothing to cancel
    expect(fake.prefetchCalls).toEqual([[]])
  })

  it('leaves a failed prefetch to the reads that need it', async () => {
    // Vitest fails the run on an unhandled rejection, so this case passing proves it's caught
    fake.prefetchResult = () => Promise.reject(new Error('node down'))
    await loadReti()
    expect(fake.prefetchCalls).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  describe('timeTravelSupportQueryOptions', () => {
    async function support() {
      const { timeTravelSupportQueryOptions } = await loadReti()
      // Called directly: the query client only adds caching
      return (timeTravelSupportQueryOptions.queryFn as () => Promise<unknown>)()
    }

    it('reports queries when the node answers them', async () => {
      expect(await support()).toEqual({
        supported: true,
        creationRound: 46_518_891n,
        creationTimestamp: 1_736_000_000,
        queries: true,
      })
    })

    it('reports no queries on a node that only simulates', async () => {
      const { query: _query, ...simulateOnly } = DT_NODE_WITH_QUERIES
      fake.sdk.getNode.mockResolvedValue(simulateOnly)
      expect(await support()).toMatchObject({ supported: true, queries: false })
    })

    it('reports nothing more without time travel', async () => {
      fake.sdk.supportsTimeTravel.mockResolvedValue(false)
      expect(await support()).toEqual({ supported: false })
    })
  })
})
