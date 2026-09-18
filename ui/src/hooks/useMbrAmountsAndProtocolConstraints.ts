import { mbrAndProtocolConstraintsQueryOptions } from '@/api/queries'
import { useQuery } from '@tanstack/react-query'

export function useMbrAmountsAndProtocolConstraints() {
  const { data } = useQuery(mbrAndProtocolConstraintsQueryOptions)
  return data
}
