import { getXGovGlobalState } from '@/api/xgovRegistry'
import { traceRead } from '@/api/trace'
import { useQuery } from '@tanstack/react-query'

export function useRegistry() {
  return useQuery({
    queryKey: ['getXGovGlobalState'],
    queryFn: () => traceRead('xgov-global-state', 'getXGovGlobalState', {}, getXGovGlobalState),
  })
}
