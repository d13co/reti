import { Link } from '@tanstack/react-router'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  VisibilityState,
} from '@tanstack/react-table'
import * as React from 'react'
import type { StakeEvent } from '@/api/history'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { InfoPopover } from '@/components/InfoPopover'
import { NfdDisplay } from '@/components/NfdDisplay'
import { Badge } from '@/components/ui/badge'
import { SkeletonText } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useSetRound } from '@/hooks/useSetRound'
import { dayjs } from '@/utils/dayjs'
import { getPoolNameFromIndex } from '@/utils/pools'
import { globalFilterFn } from '@/utils/table'
import { cn } from '@/utils/ui'

/** What the table needs of a validator to name it. */
export interface HistoryValidator {
  id: number
  config: { nfdForInfo: bigint }
}

interface StakeHistoryTableProps {
  /** Newest first */
  events: StakeEvent[]
  /** Show which validator each event was with */
  showValidator?: boolean
  /** Fewer columns, for a card */
  compact?: boolean
  /** The validators, to show their names; an id stands in for one not listed */
  validators?: HistoryValidator[]
  /** Skeleton rows to draw under the events while more may arrive */
  loadingRows?: number
}

const KIND_LABEL: Record<StakeEvent['kind'], string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  mixed: 'Mixed',
}

const KIND_VARIANT: Record<StakeEvent['kind'], 'default' | 'secondary' | 'outline'> = {
  deposit: 'default',
  withdrawal: 'secondary',
  mixed: 'outline',
}

/** A staker's deposits and withdrawals, one per row. Each round opens the app at that round. */
export function StakeHistoryTable({
  events,
  showValidator = false,
  compact = false,
  validators,
  loadingRows = 0,
}: StakeHistoryTableProps) {
  const setRound = useSetRound()

  const columns = React.useMemo<ColumnDef<StakeEvent>[]>(
    () => [
      {
        id: 'date',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {dayjs.unix(row.original.timestamp).format(compact ? 'll' : 'lll')}
          </span>
        ),
      },
      {
        id: 'validator',
        header: 'Validator',
        cell: ({ row }) => (
          <ValidatorName validatorId={Number(row.original.validatorId)} validators={validators} />
        ),
      },
      {
        id: 'pool',
        header: 'Pool',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {getPoolNameFromIndex(Number(row.original.poolId) - 1)}
          </span>
        ),
      },
      {
        id: 'kind',
        header: 'Type',
        cell: ({ row }) => <KindBadges event={row.original} />,
      },
      {
        id: 'amount',
        header: 'Amount',
        cell: ({ row }) => <Amount event={row.original} />,
      },
      {
        id: 'balanceAfter',
        header: 'Balance After',
        cell: ({ row }) => (
          <AlgoDisplayAmount
            amount={row.original.balanceAfter}
            microalgos
            mutedRemainder
            className="font-mono"
          />
        ),
      },
      {
        id: 'round',
        header: 'Round',
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setRound(row.original.round)}
            className="link font-mono text-xs underline-offset-4"
            title="See Réti as it was at this round"
          >
            {row.original.round.toLocaleString()}
          </button>
        ),
      },
    ],
    [compact, setRound, validators],
  )

  const columnVisibility: VisibilityState = {
    validator: showValidator,
    balanceAfter: !compact,
  }

  const table = useReactTable({
    data: events,
    columns,
    filterFns: { global: globalFilterFn },
    getCoreRowModel: getCoreRowModel(),
    getRowId: eventKey,
    state: { columnVisibility },
  })

  const visibleColumns = table.getVisibleLeafColumns().length

  return (
    <div className="rounded-md border">
      <Table className="border-collapse border-spacing-0" data-test-id="stake-history-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="first:px-4">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="first:px-4">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {Array.from({ length: loadingRows }, (_, i) => (
            <TableRow key={`loading-${i}`} aria-busy>
              {table.getVisibleLeafColumns().map((column) => (
                <TableCell key={column.id} className="first:px-4">
                  <SkeletonText className={column.id === 'date' ? 'w-28' : 'w-16'} />
                </TableCell>
              ))}
            </TableRow>
          ))}
          {events.length === 0 && loadingRows === 0 && (
            <TableRow>
              <TableCell colSpan={visibleColumns} className="h-24 text-center">
                No deposits or withdrawals.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

/** A stable row id: events of one round in one pool keep their order. */
function eventKey(event: StakeEvent, index: number): string {
  return `${event.poolAppId}:${event.round}:${event.kind}:${event.joined ? 'j' : ''}${event.left ? 'l' : ''}:${index}`
}

function ValidatorName({
  validatorId,
  validators,
}: {
  validatorId: number
  validators?: HistoryValidator[]
}) {
  const nfdAppId = validators?.find((v) => v.id === validatorId)?.config.nfdForInfo ?? 0n
  return (
    <Link
      to="/validators/$validatorId"
      params={{ validatorId: String(validatorId) }}
      className="link underline-offset-4 whitespace-nowrap"
    >
      {nfdAppId > 0n ? <NfdDisplay nameOrId={nfdAppId} truncate /> : `Validator ${validatorId}`}
    </Link>
  )
}

function KindBadges({ event }: { event: StakeEvent }) {
  return (
    <span className="flex items-center gap-x-1.5 whitespace-nowrap">
      <Badge variant={KIND_VARIANT[event.kind]}>{KIND_LABEL[event.kind]}</Badge>
      {event.joined && <span className="text-xs text-muted-foreground">joined</span>}
      {event.left && <span className="text-xs text-muted-foreground">left</span>}
    </span>
  )
}

function Amount({ event }: { event: StakeEvent }) {
  const sign = event.kind === 'deposit' ? '+' : event.kind === 'withdrawal' ? '−' : ''
  return (
    <span
      className={cn('flex items-center gap-x-1.5 whitespace-nowrap font-mono', {
        'text-muted-foreground': event.kind === 'mixed',
      })}
    >
      <span aria-hidden>{sign}</span>
      <AlgoDisplayAmount amount={event.amount} microalgos mutedRemainder />
      {event.rewardTokenPaid !== undefined && (
        <span className="font-sans text-xs text-muted-foreground">+ reward tokens</span>
      )}
      {event.approximate && (
        <InfoPopover label="Approximate amount">
          The pool paid an epoch reward in the same block this stake was withdrawn, so the amount
          may be short by that block&apos;s reward.
        </InfoPopover>
      )}
      {event.kind === 'mixed' && (
        <InfoPopover label="Mixed">
          A deposit and a withdrawal in the same block. This is the net amount.
        </InfoPopover>
      )}
    </span>
  )
}

/** What the history can't show: each needs two actions by the staker in one block. */
export function StakeHistoryNote({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      Rebuilt from on-chain state. Actions taken in the same block (about 3 seconds) merge into one
      row: several deposits show as one, a deposit and a withdrawal show their net amount, a deposit
      followed by a full exit shows only the exit, and joining and leaving a pool in one block
      doesn&apos;t show. Removals by a validator count as withdrawals, and reward token claims
      outside a withdrawal aren&apos;t listed.
    </p>
  )
}
