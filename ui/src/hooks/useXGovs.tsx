import { getXGovBoxes } from '@/api/xgovRegistry'
import { traceRead } from '@/api/trace'
import { useQuery } from '@tanstack/react-query'

export function useXGovs(xgovAddresses: string[]) {
  return useQuery({
    queryKey: ['getXGovBoxes', xgovAddresses],
    queryFn: () =>
      traceRead('xgov-boxes', 'getXGovBoxes', { xgovs: xgovAddresses?.length }, () =>
        getXGovBoxes(xgovAddresses!),
      ),
    enabled: xgovAddresses.length > 0,
  })
}
