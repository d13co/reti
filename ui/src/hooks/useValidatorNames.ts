import { useQueries } from '@tanstack/react-query'
import * as React from 'react'
import { nfdQueryOptions } from '@/api/queries'

/**
 * The NFD names of validators that have one, by id, as they resolve. Shares its lookups with the
 * table's names (same queries), so it adds no requests.
 */
export function useValidatorNames(
  validatorIds: number[],
  validators?: { id: number; config: { nfdForInfo: bigint } }[],
  round?: bigint,
): Map<number, string> {
  const nfdAppIds = validatorIds.map(
    (id) => validators?.find((v) => v.id === id)?.config.nfdForInfo ?? 0n,
  )
  const nfdQueries = useQueries({
    queries: nfdAppIds.map((nfdAppId) => ({
      ...nfdQueryOptions(nfdAppId, round),
      enabled: nfdAppId > 0n,
      // A slot never shows another validator's name while its own loads
      placeholderData: undefined,
    })),
  })
  const entries: [number, string][] = []
  nfdQueries.forEach((query, i) => {
    if (nfdAppIds[i] > 0n && query.data?.name) entries.push([validatorIds[i], query.data.name])
  })
  // The same map while the names stay the same, so what's built from it isn't rebuilt each render
  const key = entries.map(([id, name]) => `${id}=${name}`).join('|')
  const names = React.useRef({ key, map: new Map(entries) })
  if (names.current.key !== key) names.current = { key, map: new Map(entries) }
  return names.current.map
}
