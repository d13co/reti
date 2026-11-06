import { Nfd } from '@/interfaces/nfd'
import { ACCOUNT_3, ACCOUNT_4 } from '@/utils/tests/fixtures/accounts'

export const MOCK_ROOT_NFD: Nfd = {
  appID: 12345,
  asaID: 67890,
  caAlgo: [ACCOUNT_3, ACCOUNT_4],
  category: 'common',
  currentAsOfBlock: 1000000,
  name: 'example.algo',
  owner: ACCOUNT_3,
  properties: {
    userDefined: {},
  },
  state: 'owned',
}
