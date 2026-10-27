import { createCoalescingScheduler } from '@/lib/coalescingScheduler'

describe('createCoalescingScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs an update that arrives while idle on the next tick', () => {
    const schedule = createCoalescingScheduler(100)
    const ran: number[] = []
    schedule(() => ran.push(1))
    expect(ran).toEqual([])
    vi.advanceTimersByTime(0)
    expect(ran).toEqual([1])
  })

  it('holds what follows a run until the window ends, then runs it together, in order', () => {
    const schedule = createCoalescingScheduler(100)
    const ran: number[] = []
    schedule(() => ran.push(1))
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(30)
    schedule(() => ran.push(2))
    vi.advanceTimersByTime(30)
    schedule(() => ran.push(3))
    vi.advanceTimersByTime(39)
    expect(ran).toEqual([1])
    vi.advanceTimersByTime(1)
    expect(ran).toEqual([1, 2, 3])
  })

  it('runs straight away again once a window has passed with nothing to run', () => {
    const schedule = createCoalescingScheduler(100)
    const ran: number[] = []
    schedule(() => ran.push(1))
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(250)
    schedule(() => ran.push(2))
    vi.advanceTimersByTime(0)
    expect(ran).toEqual([1, 2])
  })

  it('defers to the next window what a running callback schedules', () => {
    const schedule = createCoalescingScheduler(100)
    const ran: string[] = []
    schedule(() => {
      ran.push('outer')
      schedule(() => ran.push('inner'))
    })
    vi.advanceTimersByTime(0)
    expect(ran).toEqual(['outer'])
    vi.advanceTimersByTime(99)
    expect(ran).toEqual(['outer'])
    vi.advanceTimersByTime(1)
    expect(ran).toEqual(['outer', 'inner'])
  })

  it('runs the rest of a batch when one callback throws, then rethrows', () => {
    const schedule = createCoalescingScheduler(100)
    const ran: number[] = []
    schedule(() => {
      throw new Error('boom')
    })
    schedule(() => ran.push(2))
    expect(() => vi.advanceTimersByTime(0)).toThrow('boom')
    expect(ran).toEqual([2])
  })
})
