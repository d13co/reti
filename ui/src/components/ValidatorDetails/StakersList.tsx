import { useNavigate } from '@tanstack/react-router'
import { BarList } from '@tremor/react'
import * as React from 'react'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StakerChartData } from '@/interfaces/staking'
import { cn } from '@/utils/ui'

interface StakersListProps {
  chartData: StakerChartData[]
}

/** A staker's history page path: `/history/<address>`. */
const HISTORY_PATH = /^\/history\/([A-Z2-7]{58})$/

export function StakersList({ chartData }: StakersListProps) {
  const navigate = useNavigate()

  // Tremor renders each staker as a plain link, which would reload the app: route a plain click
  // in the app instead, and leave modified clicks (new tab, new window) to the browser
  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    const link = (event.target as Element).closest('a')
    const address = link && new URL(link.href).pathname.match(HISTORY_PATH)?.[1]
    if (!address) return
    event.preventDefault()
    void navigate({ to: '/history/$address', params: { address } })
  }

  const valueFormatter = (v: number) => (
    <AlgoDisplayAmount
      amount={v}
      microalgos
      maxLength={13}
      compactPrecision={2}
      trim={false}
      mutedRemainder
      className="font-mono"
    />
  )

  if (chartData.length === 0) {
    return null
  }

  return (
    <ScrollArea
      className={cn('rounded-lg border', {
        'h-64': chartData.length > 6,
        'sm:h-96': chartData.length > 9,
      })}
    >
      <div className="p-2 pr-6" onClickCapture={handleClickCapture}>
        <BarList
          data={chartData}
          valueFormatter={valueFormatter}
          className="font-mono underline-offset-4"
          showAnimation
        />
      </div>
    </ScrollArea>
  )
}
