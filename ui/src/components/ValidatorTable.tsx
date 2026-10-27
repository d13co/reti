import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Link } from '@tanstack/react-router'
import {
  ColumnDef,
  ColumnFiltersState,
  Row,
  SortingFn,
  SortingState,
  Updater,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { useViewedTime, useWriteAddress } from '@/hooks/useAtRound'
import { useBlockTime } from '@/hooks/useBlockTime'
import { Ban, ChevronRight, Sunset } from 'lucide-react'
import * as React from 'react'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { AlgoSymbol } from '@/components/AlgoSymbol'
import { DataTableColumnHeader } from '@/components/DataTableColumnHeader'
import { DataTableViewOptions } from '@/components/DataTableViewOptions'
import { DebouncedSearch } from '@/components/DebouncedSearch'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import { TrafficLight } from '@/components/TrafficLight'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ValidatorActionsCell } from '@/components/ValidatorActionsCell'
import { ValidatorInfoRow } from '@/components/ValidatorInfoRow'
import { NfdLoadingDisplay } from '@/components/NfdDisplay'
import { ValidatorNfdDisplay } from '@/components/ValidatorNfdDisplay'
import { ValidatorStatus } from '@/components/ValidatorStatus'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { StakerValidatorData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'
import {
  calculateMaxStake,
  calculateSaturationPercentage,
  calculateStakeSaturation,
  isSunsetted,
  isSunsetting,
} from '@/utils/contracts'
import { dayjs } from '@/utils/dayjs'
import { ellipseAddressJsx } from '@/utils/ellipseAddress'
import { compactFormat, formatAmount, formatAssetAmount } from '@/utils/format'
import { globalFilterFn, ineligibleFilter, MIN_ELIGIBLE_STAKE, sunsetFilter } from '@/utils/table'
import { cn } from '@/utils/ui'
import { ValidatorRewards } from '@/components/ValidatorRewards'

interface ValidatorTableProps {
  validators: Validator[]
  stakesByValidator: StakerValidatorData[]
  constraints: Constraints
  isLoading: boolean
}

const sortRewardsFn: SortingFn<Validator> = (rowA, rowB) => {
  const a = rowA.original
  const b = rowB.original

  // Assign values for epoch payout status
  const getStatus = (validator: Validator): number => {
    if (validator.roundsSinceLastPayout === undefined) return 0 // red
    if (validator.roundsSinceLastPayout < 21n) return 2 // green
    if (validator.roundsSinceLastPayout < 1200n) return 1 // yellow
    return 0 // red
  }

  const statusA = getStatus(a)
  const statusB = getStatus(b)

  // Compare status
  if (statusA !== statusB) {
    return statusA - statusB
  }

  // If status is the same, compare rewardsBalance
  if (a.rewardsBalance === undefined && b.rewardsBalance === undefined) return 0
  if (a.rewardsBalance === undefined) return 1
  if (b.rewardsBalance === undefined) return -1

  // Compare rewardsBalance
  return Number(a.rewardsBalance - b.rewardsBalance)
}

/**
 * Memoized: the dashboard re-renders for every batch of enrichment data, and this table should
 * only follow when its own props change.
 */
export const ValidatorTable = React.memo(function ValidatorTable({
  validators,
  stakesByValidator,
  constraints,
  isLoading,
}: ValidatorTableProps) {
  const writeAddress = useWriteAddress()
  // The time shown, which the sunset checks (and the sunset filter) read: a past round's can
  // land after the table first renders
  const viewedTime = useViewedTime()
  // Read once here rather than in every row's status cell
  const blockTime = useBlockTime()
  // At the latest round the sunset checks read the clock, and memoized rows only re-render when
  // their validator changes: without a tick, a sunset passing on an open page would show late
  const clockMinute = useClockMinute(viewedTime === undefined)

  // Persistent column sorting state
  const [sorting, setSorting] = useLocalStorage<SortingState>('validator-sorting', [
    { id: 'stake', desc: true },
  ])

  const handleSortingChange = (updaterOrValue: Updater<SortingState>) => {
    if (typeof updaterOrValue === 'function') {
      const newState = updaterOrValue(sorting)
      setSorting(newState)
    } else {
      setSorting(updaterOrValue)
    }
  }

  // Persistent column visibility state
  const [columnVisibility, setColumnVisibility] = useLocalStorage<VisibilityState>(
    'validator-columns',
    { 'pend. reward': false },
  )

  const handleColumnVisibilityChange = (updaterOrValue: Updater<VisibilityState>) => {
    if (typeof updaterOrValue === 'function') {
      const newState = updaterOrValue(columnVisibility)
      setColumnVisibility(newState)
    } else {
      setColumnVisibility(updaterOrValue)
    }
  }

  // Persistent column filters state
  const [columnFilters, setColumnFilters] = useLocalStorage<ColumnFiltersState>(
    'validator-column-filters',
    [
      { id: 'validator', value: false },
      { id: 'stake', value: false },
    ],
  )

  const handleColumnFiltersChange = (updaterOrValue: Updater<ColumnFiltersState>) => {
    if (typeof updaterOrValue === 'function') {
      const newState = updaterOrValue(columnFilters)
      setColumnFilters(newState)
    } else {
      setColumnFilters(updaterOrValue)
    }
  }

  // Persistent global filter state
  const [globalFilter, setGlobalFilter] = useLocalStorage<string>('validator-global-filter', '')

  // Column definitions. Memoized, and every dependency must be referentially stable:
  // `flexRender` renders each `cell` as a component, so a new column array gives every cell a
  // new component type and React remounts the whole table body (tooltips and open menus too).
  const columns = React.useMemo<ColumnDef<Validator>[]>(
    () => [
      {
        id: 'expander',
        size: 48,
        header: () => null,
        cell: ({ row }) => {
          return row.getCanExpand() ? (
            <button
              type="button"
              aria-label={row.getIsExpanded() ? 'Collapse row' : 'Expand row'}
              title={row.getIsExpanded() ? 'Collapse row' : 'Expand row'}
              data-state={row.getIsExpanded() ? 'open' : 'closed'}
              className="m-0 p-2 cursor-pointer [&[data-state=open]>svg]:rotate-90"
              onClick={row.getToggleExpandedHandler()}
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : (
            <span aria-hidden="true">&nbsp;</span>
          )
        },
      },
      {
        id: 'validator',
        // The name cell's `max-w-[10rem]`, plus padding
        size: 176,
        accessorFn: (row) => row.nfd?.name || row.config.owner.toLowerCase(),
        filterFn: sunsetFilter,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Validator" />,
        cell: ({ row }) => {
          const validator = row.original
          const nfd = validator.nfd

          return (
            <div className="flex items-center gap-x-2 min-w-0 max-w-[10rem] xl:max-w-[16rem]">
              {isSunsetted(validator, viewedTime) ? (
                <Tooltip
                  content={`Sunset on ${dayjs.unix(Number(validator.config.sunsettingOn)).format('ll')}`}
                >
                  <Ban className="h-5 w-5 text-muted-foreground transition-colors" />
                </Tooltip>
              ) : isSunsetting(validator) ? (
                <Tooltip
                  content={`Will sunset on ${dayjs.unix(Number(validator.config.sunsettingOn)).format('ll')}`}
                >
                  <Sunset className="h-5 w-5 text-muted-foreground transition-colors" />
                </Tooltip>
              ) : null}
              {nfd ? (
                <ValidatorNfdDisplay
                  nfd={nfd}
                  validatorId={validator.id}
                  isSunsetted={isSunsetted(validator, viewedTime)}
                />
              ) : (
                <Link
                  to="/validators/$validatorId"
                  params={{
                    validatorId: String(validator.id),
                  }}
                  className="link underline-offset-4 whitespace-nowrap font-mono"
                  preload="intent"
                >
                  {validator.nfdLoading ? (
                    <NfdLoadingDisplay address={validator.config.owner} />
                  ) : (
                    ellipseAddressJsx(validator.config.owner)
                  )}
                </Link>
              )}
            </div>
          )
        },
      },
      {
        id: 'minEntry',
        size: 116,
        accessorFn: (row) => Number(row.config.minEntryStake),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Min Entry" />,
        cell: ({ row }) => {
          const validator = row.original
          return <AlgoDisplayAmount amount={validator.config.minEntryStake} microalgos />
        },
      },
      {
        id: 'stake',
        size: 116,
        accessorFn: (row) => Number(row.state.totalAlgoStaked),
        filterFn: ineligibleFilter,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Stake" />,
        cell: ({ row }) => {
          const validator = row.original

          if (validator.state.numPools === 0) return '--'

          const currentStakeAlgos = AlgoAmount.MicroAlgos(
            Number(validator.state.totalAlgoStaked),
          ).algos
          const currentStakeCompact = compactFormat.format(currentStakeAlgos)

          const maxStake = calculateMaxStake(validator, constraints)
          const maxStakeAlgos = AlgoAmount.MicroAlgos(Number(maxStake)).algos
          const maxStakeCompact = compactFormat.format(maxStakeAlgos)

          const saturationLevel = calculateStakeSaturation(validator, constraints)
          const saturationPercent = calculateSaturationPercentage(validator, constraints)

          return (
            <span className="whitespace-nowrap">
              <AlgoSymbol />
              {currentStakeCompact} / {maxStakeCompact}
              <TrafficLight
                tooltipContent={`${saturationPercent}%`}
                indicator={saturationLevel}
                className="ml-2"
              />
            </span>
          )
        },
      },
      {
        id: 'status',
        size: 96,
        accessorFn: (row) => row.rewardsBalance,
        sortingFn: sortRewardsFn,
        sortUndefined: -1,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => {
          const validator = row.original
          if (validator.state.numPools == 0) return '--'

          return <ValidatorStatus validator={validator} blockTime={blockTime} />
        },
      },
      {
        id: 'apy',
        size: 110,
        accessorFn: (row) => row.apy,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Est. APY" />,
        cell: ({ row }) => {
          if (!row.original.apy) return <span className="text-muted-foreground">--</span>
          return (
            <Tooltip
              content={`${formatAmount(Number(row.original.extDeposits), { precision: 2 })} in extra deposits`}
            >
              <span>
                {formatAmount(row.original.apy < 0 ? 0 : row.original.apy, { precision: 1 })}%
              </span>
            </Tooltip>
          )
        },
      },
      {
        id: 'pend. reward',
        size: 152,
        accessorFn: (row) => row.rewardsBalance,
        sortingFn: sortRewardsFn,
        sortUndefined: -1,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Pend. Rewards" />,
        cell: ({ row }) => {
          const validator = row.original
          if (validator.state.numPools == 0) return '--'

          return <ValidatorRewards validator={validator} />
        },
      },
      {
        id: 'token',
        size: 94,
        accessorFn: (row) => row.config.rewardTokenId,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Token" />,
        cell: ({ row }) => {
          const validator = row.original
          if (!validator.rewardToken) {
            return <span className="text-muted-foreground">--</span>
          }

          const perEpochAmount = formatAssetAmount(
            validator.rewardToken,
            validator.config.rewardPerPayout,
            { unitName: true },
          )

          const tooltipContent = `${perEpochAmount} per epoch`

          return (
            <Tooltip content={tooltipContent}>
              <span className="font-mono">{validator.rewardToken.params?.unitName}</span>
            </Tooltip>
          )
        },
      },
      {
        id: 'fee',
        size: 80,
        accessorFn: (row) => row.config.percentToValidator,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Fee" />,
        cell: ({ row }) => {
          const validator = row.original
          const percent = Number(validator.config.percentToValidator) / 10000
          return `${percent}%`
        },
      },
      {
        id: 'actions',
        size: 128,
        cell: ({ row }) => (
          <ValidatorActionsCell
            validator={row.original}
            constraints={constraints}
            writeAddress={writeAddress}
            stakesByValidator={stakesByValidator}
          />
        ),
      },
    ],
    [constraints, viewedTime, blockTime, writeAddress, stakesByValidator],
  )

  // A new array when the time shown changes, so the table re-runs the sunset filter
  const data = React.useMemo(() => [...validators], [validators, viewedTime])

  const table = useReactTable<Validator>({
    data,
    columns,
    filterFns: {
      global: globalFilterFn,
    },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'global',
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: handleSortingChange,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: handleColumnFiltersChange,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: handleColumnVisibilityChange,
    // By validator rather than position, so a row (its React key, its expanded state) follows its
    // validator through re-sorts and refetches
    getRowId: (validator) => String(validator.id),
    getRowCanExpand: () => true,
    getExpandedRowModel: getExpandedRowModel(),
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      globalFilter,
    },
  })

  const { rows } = table.getRowModel()
  // Where the rows start, for the virtualizer
  const headerRef = React.useRef<HTMLTableSectionElement>(null)

  // The visible columns, as a value the memoized rows can compare
  const visibleColumns = table
    .getVisibleLeafColumns()
    .map((column) => column.id)
    .join(',')

  // Pre-filtered count of sunsetted validators
  const sunsetCount = table
    .getPreFilteredRowModel()
    .rows.filter((row) => isSunsetted(row.original)).length

  // Pre-filtered count of ineligible validators
  const ineligibleCount = table
    .getPreFilteredRowModel()
    .rows.filter((row) => row.original.state.totalAlgoStaked < MIN_ELIGIBLE_STAKE).length

  return (
    <>
      <div>
        <div className="sm:flex items-center sm:gap-x-3 py-3">
          <h2 className="flex items-center mb-2 text-lg font-semibold sm:flex-1 sm:my-1">
            Validators {isLoading && <Loading size="sm" inline className="ml-3" />}
          </h2>
          <div className="flex items-center gap-x-4 mb-3 sm:mb-0">
            <div
              className={cn('flex items-center gap-x-2 h-7 sm:h-9 px-3', {
                hidden: sunsetCount === 0,
              })}
            >
              <Checkbox
                checked={(table.getColumn('validator')?.getFilterValue() as boolean) ?? false}
                onCheckedChange={(checked) =>
                  table.getColumn('validator')?.setFilterValue(!!checked)
                }
              />
              <label
                htmlFor="show-sunsetted"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Show sunsetted ({sunsetCount})
              </label>
            </div>
            <div className="flex items-center gap-x-2 h-7 sm:h-9 px-3">
              <Checkbox
                checked={(table.getColumn('stake')?.getFilterValue() as boolean) ?? false}
                onCheckedChange={(checked) => table.getColumn('stake')?.setFilterValue(!!checked)}
              />
              <label
                htmlFor="show-ineligible"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Show ineligible ({ineligibleCount})
              </label>
            </div>
          </div>
          <div className="flex items-center gap-x-3 flex-wrap sm:flex-0">
            <div className="flex items-center gap-x-3 w-full sm:w-auto">
              <div className="flex-1">
                <DebouncedSearch
                  placeholder="Filter validators..."
                  value={globalFilter ?? ''}
                  onSearch={(value) => setGlobalFilter(String(value))}
                  className="w-full sm:max-w-sm lg:w-64"
                />
              </div>
              <DataTableViewOptions table={table} className="h-9" />
            </div>
          </div>
        </div>
        <div className="rounded-md border">
          {/* Fixed layout, from each column's `size`: only the rows near the viewport are mounted,
              and sized by their content the columns would shift as rows scroll in and out. The
              sizes fit the widest content; the table never shrinks below them, so narrow screens
              scroll it sideways. Each row has its own <tbody>: drop the bottom border of the last
              one, which sits on the container's border */}
          <Table
            className="table-fixed border-collapse border-spacing-0 [&>tbody:last-child>tr:last-child]:border-0"
            style={{ minWidth: table.getTotalSize() }}
          >
            <TableHeader ref={headerRef}>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead
                        key={header.id}
                        className={cn(
                          'first:px-0',
                          // Room for the name cell's `xl:max-w-[16rem]`, plus padding (the size
                          // fits its narrower cap below xl)
                          header.column.id === 'validator' && 'xl:!w-[17rem]',
                        )}
                        style={{ width: header.getSize() }}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            {rows.length ? (
              <VirtualRows
                rows={rows}
                headerRef={headerRef}
                columns={columns}
                visibleColumns={visibleColumns}
                constraints={constraints}
                clockMinute={clockMinute}
              />
            ) : (
              <TableBody>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    {isLoading ? 'Loading...' : 'No results'}
                  </TableCell>
                </TableRow>
              </TableBody>
            )}
          </Table>
        </div>
      </div>
    </>
  )
})

/** A collapsed row's height, before it is measured */
const ROW_HEIGHT_ESTIMATE = 53

interface VirtualRowsProps {
  rows: Row<Validator>[]
  /** The table header: the rows start at its bottom edge */
  headerRef: React.RefObject<HTMLTableSectionElement>
  columns: ColumnDef<Validator>[]
  visibleColumns: string
  constraints: Constraints
  clockMinute: number
}

/**
 * The table body, rendering only the rows near the viewport. The page scrolls rather than the
 * table, so this follows the window. A row and its details share one `<tbody>`, measured as one
 * item, so an expanded row takes its real height. Kept apart from the table so that the re-renders
 * scrolling causes stop here.
 */
function VirtualRows({
  rows,
  headerRef,
  columns,
  visibleColumns,
  constraints,
  clockMinute,
}: VirtualRowsProps) {
  const scrollMargin = useDocumentBottom(headerRef)
  // Stable while the rows are, which lets the virtualizer keep its measurements between scrolls.
  // Tolerates an index past the end: a deferred render can set new rows before they commit, while
  // the old ones are still on screen being measured
  const getItemKey = React.useCallback((index: number) => rows[index]?.id ?? index, [rows])
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 8,
    getItemKey,
    scrollMargin,
  })

  const items = virtualizer.getVirtualItems()
  // Item offsets count from the top of the page; the total size counts from the first row
  const paddingTop = items.length ? items[0].start - scrollMargin : 0
  const paddingBottom = items.length
    ? virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin)
    : 0
  const colSpan = visibleColumns.split(',').length

  return (
    <>
      {paddingTop > 0 && <SpacerBody height={paddingTop} colSpan={colSpan} />}
      {items.map((item) => {
        const row = rows[item.index]
        return (
          <tbody key={row.id} data-index={item.index} ref={virtualizer.measureElement}>
            <ValidatorRow
              row={row}
              validator={row.original}
              expanded={row.getIsExpanded()}
              columns={columns}
              visibleColumns={visibleColumns}
              constraints={constraints}
              clockMinute={clockMinute}
            />
          </tbody>
        )
      })}
      {paddingBottom > 0 && <SpacerBody height={paddingBottom} colSpan={colSpan} />}
    </>
  )
}

/** Stands in for the rows scrolled out of view, so the page keeps its full height. */
function SpacerBody({ height, colSpan }: { height: number; colSpan: number }) {
  return (
    <tbody aria-hidden="true">
      <tr>
        <td colSpan={colSpan} style={{ height, padding: 0 }} />
      </tr>
    </tbody>
  )
}

/**
 * The element's bottom edge, measured from the top of the page. It is re-measured when the app's
 * root resizes, which is when the content above it (the chart, the stakes table) can have moved
 * it. The root rather than `<body>`, which stops growing with the content if it gets a height.
 */
function useDocumentBottom(ref: React.RefObject<HTMLElement>): number {
  const [bottom, setBottom] = React.useState(0)
  React.useLayoutEffect(() => {
    const measure = () => {
      const element = ref.current
      if (!element) return
      const next = element.getBoundingClientRect().bottom + window.scrollY
      setBottom((previous) => (Math.abs(previous - next) < 0.5 ? previous : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(document.getElementById('app') ?? document.body)
    return () => observer.disconnect()
  }, [ref])
  return bottom
}

interface ValidatorRowProps {
  row: Row<Validator>
  /** Compared instead of `row`, which the table rebuilds for every row whenever any data changes */
  validator: Validator
  expanded: boolean
  /** The cells close over the table's shared values; a new array means those changed */
  columns: ColumnDef<Validator>[]
  visibleColumns: string
  constraints: Constraints
  /** Re-renders the row each minute while the sunset checks read the clock */
  clockMinute: number
}

/**
 * One validator's row, plus its details when expanded. Memoized on the validator object, which
 * `useValidators` keeps while nothing about that validator changed, so a batch of data that
 * touches a few validators re-renders only their rows.
 */
const ValidatorRow = React.memo(
  function ValidatorRow({ row, expanded, constraints }: ValidatorRowProps) {
    const cells = row.getVisibleCells()
    return (
      <>
        <TableRow
          className={cn({
            'text-foreground/50': isSunsetted(row.original),
            'border-b-0 bg-muted/25': expanded,
          })}
        >
          {cells.map((cell) => (
            <TableCell key={cell.id} className="first:pr-0">
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </TableCell>
          ))}
        </TableRow>
        {expanded && (
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableCell colSpan={cells.length} className="p-0">
              <ValidatorInfoRow validator={row.original} constraints={constraints} />
            </TableCell>
          </TableRow>
        )}
      </>
    )
  },
  (previous, next) =>
    previous.validator === next.validator &&
    previous.expanded === next.expanded &&
    previous.columns === next.columns &&
    previous.visibleColumns === next.visibleColumns &&
    previous.constraints === next.constraints &&
    previous.clockMinute === next.clockMinute,
)

/** The current minute while `enabled`, ticking; 0 otherwise. */
function useClockMinute(enabled: boolean): number {
  const [minute, setMinute] = React.useState(() => Math.floor(Date.now() / 60_000))
  React.useEffect(() => {
    if (!enabled) return
    const tick = () => setMinute(Math.floor(Date.now() / 60_000))
    tick()
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [enabled])
  return enabled ? minute : 0
}
