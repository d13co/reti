import * as React from 'react'
import {
  Tooltip as TooltipPrimative,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/utils/ui'

/** Set under {@link SharedTooltipProvider}, so each tooltip can skip mounting its own provider. */
const SharedProviderContext = React.createContext(false)

/**
 * One tooltip provider for the whole app. The tables render several tooltips per row, and a
 * provider apiece multiplies what every row mounts. A shared provider also lets the pointer move
 * between neighbouring tooltips without waiting out the open delay again.
 */
export function SharedTooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <SharedProviderContext.Provider value={true}>{children}</SharedProviderContext.Provider>
    </TooltipProvider>
  )
}

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  variant?: 'default' | 'primary'
}

export function Tooltip({ content, children, variant = 'default' }: TooltipProps) {
  const tooltip = (
    <TooltipPrimative>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        className={cn(
          variant === 'default'
            ? 'bg-stone-900 text-white font-semibold tracking-tight dark:bg-white dark:text-stone-900'
            : '',
        )}
      >
        {content}
      </TooltipContent>
    </TooltipPrimative>
  )

  // Outside the shared provider (tests rendering a component on its own), bring one along
  return React.useContext(SharedProviderContext) ? (
    tooltip
  ) : (
    <TooltipProvider>{tooltip}</TooltipProvider>
  )
}
