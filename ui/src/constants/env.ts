// Hosts like Cloudflare Pages don't accept empty env values, so a literal "" counts as unset
const envValue = (value: string | undefined) => (value === '""' ? '' : (value ?? ''))

export const WALLETCONNECT_PROJECT_ID = envValue(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID)
