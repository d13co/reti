import { CirclePlus, Coins, Percent, Users } from 'lucide-react'
import * as React from 'react'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { PoolIcon } from '@/components/PoolIcon'
import { RefreshOverlay } from '@/components/RefreshOverlay'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SkeletonText } from '@/components/ui/skeleton'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { Validator } from '@/interfaces/validator'
import { calculateMaxStakers } from '@/utils/contracts'
import { cn } from '@/utils/ui'

interface HighlightsProps {
  /** Undefined while the page first loads: the cards show placeholders */
  validator?: Validator
  constraints?: Constraints
  setAddPoolValidator?: (validator: Validator | null) => void
  canAddPool?: boolean
  /** The figures are from the previous round while this one loads */
  refreshing?: boolean
}

const HIGHLIGHTS = [
  { title: 'Total Staked', Icon: Coins },
  { title: 'Stakers', Icon: Users },
  { title: 'Pools', Icon: PoolIcon },
  { title: 'Commission', Icon: Percent },
] as const

const VALUE_CLASS = 'text-2xl font-bold lg:text-xl xl:text-2xl'

/** The four headline figures, each in its own card. */
export function Highlights({
  validator,
  constraints,
  setAddPoolValidator,
  canAddPool = false,
  refreshing = false,
}: HighlightsProps) {
  const values = React.useMemo((): React.ReactNode[] | undefined => {
    if (!validator || !constraints) return undefined
    const maxStakers = calculateMaxStakers(validator, constraints)
    const maxPools = validator.config.poolsPerNode * Number(constraints.maxNodes)
    return [
      <AlgoDisplayAmount
        key="staked"
        amount={validator.state.totalAlgoStaked}
        microalgos
        maxLength={13}
        compactPrecision={2}
        mutedRemainder
      />,
      <React.Fragment key="stakers">
        {validator.state.totalStakers.toString()}{' '}
        <span className="text-muted-foreground">/ {maxStakers.toString()}</span>
      </React.Fragment>,
      <React.Fragment key="pools">
        {validator.state.numPools.toString()}{' '}
        <span className="text-muted-foreground">/ {maxPools.toString()}</span>
        {canAddPool && (
          <Button
            variant="ghost"
            size="icon"
            className="group -my-2"
            onClick={() => setAddPoolValidator?.(validator)}
          >
            <CirclePlus className="h-5 w-5 text-muted-foreground transition-colors group-hover:text-foreground" />
          </Button>
        )}
      </React.Fragment>,
      `${Number(validator.config.percentToValidator) / 10000}%`,
    ]
  }, [validator, constraints, canAddPool, setAddPoolValidator])

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {HIGHLIGHTS.map(({ title, Icon }, index) => (
        <Card key={title} className="relative" aria-busy={refreshing || !values}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle as="h2" className="text-sm font-medium">
              {title}
            </CardTitle>
            <Icon className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={cn(VALUE_CLASS, title === 'Pools' && 'flex items-center gap-x-2')}>
              {values ? values[index] : <SkeletonText className="w-28" />}
            </div>
          </CardContent>
          <RefreshOverlay active={refreshing && !!values} />
        </Card>
      ))}
    </div>
  )
}
