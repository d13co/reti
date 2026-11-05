import * as React from 'react'

/** Keeps the first `value` for as long as `key` stays the same. */
export function useStableBy<T>(value: T, key: string): T {
  const ref = React.useRef({ key, value })
  if (ref.current.key !== key) ref.current = { key, value }
  return ref.current.value
}
