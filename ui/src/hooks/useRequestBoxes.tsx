import { getXGovRequestBoxes } from '@/api/xgovRegistry'
import { traceRead } from '@/api/trace'
import { useQuery } from '@tanstack/react-query'

export function useRequestBoxes(ownerAddress: string | null, xgovAddresses: string[]) {
  return useQuery({
    queryKey: ['getXGovRequestBoxes', ownerAddress, JSON.stringify([...xgovAddresses].sort())],
    queryFn: () =>
      traceRead(
        'xgov-request-boxes',
        'getXGovRequestBoxes',
        { owner: ownerAddress, xgovs: xgovAddresses?.length },
        () => getXGovRequestBoxes(ownerAddress!, xgovAddresses!),
      ),
    enabled: !!ownerAddress && xgovAddresses.length > 0,
  })
}
