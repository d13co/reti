import { mbrAndProtocolConstraintsQueryOptions } from '@/api/queries'
import { useQuery } from '@tanstack/react-query'
import { MbrAmountsAndProtocolConstraints } from 'reti-ghost-sdk/dist/generated/RetiReaderSDK'

export function useMbrAmountsAndProtocolConstraints():
  | MbrAmountsAndProtocolConstraints
  | undefined {
  const { data } = useQuery(mbrAndProtocolConstraintsQueryOptions)
  return data
}
