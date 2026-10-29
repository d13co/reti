import { Link } from '@tanstack/react-router'
import { useWriteAddress } from '@/hooks/useAtRound'
import { ArrowUpRight } from 'lucide-react'

export function Navigation() {
  // Adding a validator is a write, so the link is hidden while time travelling
  const activeAddress = useWriteAddress()
  const isTestnet = import.meta.env.VITE_ALGOD_NETWORK === 'testnet'
  // Upgrade history is read from past state, which only a time travel read node has
  const hasHistory = !!import.meta.env.VITE_DT_ALGOD_SERVER

  return (
    <nav className="hidden flex-col gap-6 text-lg font-medium md:flex md:flex-row md:items-center md:gap-5 md:text-sm lg:gap-6">
      <Link
        to="/"
        className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
      >
        Dashboard
      </Link>

      {activeAddress && (
        <Link
          to="/add"
          className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
        >
          Add Validator
        </Link>
      )}

      {hasHistory && (
        <Link
          to="/upgrades"
          className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
        >
          Node Upgrades
        </Link>
      )}

      <Link
        to="/institutional-support"
        className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
      >
        Institutional Support
      </Link>

      <a
        href="https://txnlab.gitbook.io/reti-open-pooling"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        Docs
        <ArrowUpRight className="h-5 w-5 opacity-75" />
      </a>

      {isTestnet && (
        <a
          href="https://bank.testnet.algorand.network/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          Dispenser
          <ArrowUpRight className="h-5 w-5 opacity-75" />
        </a>
      )}
    </nav>
  )
}
