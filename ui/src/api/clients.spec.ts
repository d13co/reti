import { assertWritable, isTimeTravelling, ReadOnlyError } from '@/api/clients'

/** Puts `search` in the page URL, as the router would. */
const at = (search: string) => window.history.replaceState(null, '', `/${search}`)

afterEach(() => at(''))

describe('isTimeTravelling', () => {
  it('is true at a valid past round', () => {
    at('?round=123')
    expect(isTimeTravelling()).toBe(true)
  })

  it('is false live, and for a round the UI ignores', () => {
    for (const search of ['', '?round=', '?round=0', '?round=abc', '?round=-5', '?other=1']) {
      at(search)
      expect(isTimeTravelling(), search).toBe(false)
    }
  })
})

describe('assertWritable', () => {
  it('throws ReadOnlyError while time travelling', () => {
    at('?round=123')
    expect(() => assertWritable()).toThrow(ReadOnlyError)
  })

  it('passes live, and for a round the UI ignores', () => {
    at('?round=abc')
    expect(() => assertWritable()).not.toThrow()
  })
})
