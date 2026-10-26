/**
 * The read layer's module setup, against a fake `RetiGhostSDK` (the other specs replace this whole
 * module with `mockRetiModule()`). Each case loads a fresh copy of the module.
 */

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
      getChangeRounds: async () => ({ changes: [] }),
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
})
