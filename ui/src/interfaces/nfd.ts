/**
 * An NFD as the app shows it: an `nfd-ghost-sdk` record read on chain (see `nfdFromRecord` in
 * `@/api/nfd`), in the shape the NFD REST API used to give, which the components were written
 * against. Only the fields the SDK reads are here.
 */
export interface Nfd {
  name: string
  /** NFD application id */
  appID?: number
  /** NFD asset id */
  asaID?: number
  /** Owner of the NFD */
  owner?: string
  /** NFD application id of the parent, if this is a segment */
  parentAppID?: number
  category?: 'curated' | 'premium' | 'common'
  /** Unowned and expired NFDs are both up for grabs: `available` */
  state?: 'available' | 'forSale' | 'owned'
  /** Verified Algorand addresses */
  caAlgo?: string[]
  properties?: {
    userDefined?: {
      /** The user-defined avatar, else the verified one */
      avatar?: string
      bio?: string
    }
  }
  /** The round it was read at */
  currentAsOfBlock?: number
}
