import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { DataTableColumnHeader } from '@/components/DataTableColumnHeader'
import { DataTableViewOptions } from '@/components/DataTableViewOptions'
import { DebouncedSearch } from '@/components/DebouncedSearch'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
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
import { ValidatorNfdDisplay } from '@/components/ValidatorNfdDisplay'
import { ValidatorRewards } from '@/components/ValidatorRewards'
import { ValidatorStakeDisplay } from '@/components/ValidatorStakeDisplay'
import { ValidatorStatus } from '@/components/ValidatorStatus'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { Validator } from '@/interfaces/validator'
import { isSunsetted, isSunsetting } from '@/utils/contracts'
import { dayjs } from '@/utils/dayjs'
import { ellipseAddressJsx } from '@/utils/ellipseAddress'
import { formatAmount, formatAssetAmount } from '@/utils/format'
import { globalFilterFn, ineligibleFilter, MIN_ELIGIBLE_STAKE, sunsetFilter } from '@/utils/table'
import { cn } from '@/utils/ui'
import { Link } from '@tanstack/react-router'
import {
  ColumnDef,
  ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  SortingState,
  Updater,
  useReactTable,
  VisibilityState,
} from '@tanstack/react-table'
import { Ban, ChevronRight, Sunset } from 'lucide-react'
import * as React from 'react'
import { sortRewardsFn } from '../utils/sortRewardsFn'

interface ValidatorTableProps {
  validators: Validator[]
  isLoading: boolean
}

const columns: ColumnDef<Validator>[] = [
  {
    id: 'expander',
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
    accessorFn: (row) => row.nfd?.name || row.config.owner.toLowerCase(),
    filterFn: sunsetFilter,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Validator" />,
    cell: ({ row }) => {
      const validator = row.original
      const nfd = validator.nfd

      return (
        <div className="flex items-center gap-x-2 min-w-0 max-w-[10rem] xl:max-w-[16rem]">
          {isSunsetted(validator) ? (
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
              isSunsetted={isSunsetted(validator)}
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
              {ellipseAddressJsx(validator.config.owner)}
            </Link>
          )}
        </div>
      )
    },
  },
  {
    id: 'minEntry',
    accessorFn: (row) => Number(row.config.minEntryStake),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Min Entry" />,
    cell: ({ row }) => {
      const validator = row.original
      return <AlgoDisplayAmount amount={validator.config.minEntryStake} microalgos />
    },
  },
  {
    id: 'stake',
    accessorFn: (row) => Number(row.state.totalAlgoStaked),
    filterFn: ineligibleFilter,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Stake" />,
    cell: ({ row }) => {
      const validator = row.original
      return <ValidatorStakeDisplay validator={validator} />
    },
  },
  {
    id: 'status',
    accessorFn: (row) => row.rewardsBalance,
    sortingFn: sortRewardsFn,
    sortUndefined: -1,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => {
      const validator = row.original
      if (validator.state.numPools == 0) return '--'

      return <ValidatorStatus validator={validator} />
    },
  },
  {
    id: 'apy',
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
          <span className="font-mono">{validator.rewardToken.params.unitName}</span>
        </Tooltip>
      )
    },
  },
  {
    id: 'fee',
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
    cell: ({ row }) => <ValidatorActionsCell validator={row.original} />,
    size: 120,
  },
]

export function ValidatorTable({ validators, isLoading }: ValidatorTableProps) {
  // Persistent column sorting state
  const [sorting, setSorting] = useLocalStorage<SortingState>('validator-sorting', [
    { id: 'stake', desc: true },
  ])

  const handleSortingChange = React.useCallback(
    (updaterOrValue: Updater<SortingState>) => {
      if (typeof updaterOrValue === 'function') {
        const newState = updaterOrValue(sorting)
        setSorting(newState)
      } else {
        setSorting(updaterOrValue)
      }
    },
    [sorting, setSorting],
  )

  // Persistent column visibility state
  const [columnVisibility, setColumnVisibility] = useLocalStorage<VisibilityState>(
    'validator-columns',
    { 'pend. reward': false },
  )

  const handleColumnVisibilityChange = React.useCallback(
    (updaterOrValue: Updater<VisibilityState>) => {
      if (typeof updaterOrValue === 'function') {
        const newState = updaterOrValue(columnVisibility)
        setColumnVisibility(newState)
      } else {
        setColumnVisibility(updaterOrValue)
      }
    },
    [columnVisibility, setColumnVisibility],
  )

  // Persistent column filters state
  const [columnFilters, setColumnFilters] = useLocalStorage<ColumnFiltersState>(
    'validator-column-filters',
    [
      { id: 'validator', value: false },
      { id: 'stake', value: false },
    ],
  )

  const handleColumnFiltersChange = React.useCallback(
    (updaterOrValue: Updater<ColumnFiltersState>) => {
      if (typeof updaterOrValue === 'function') {
        const newState = updaterOrValue(columnFilters)
        setColumnFilters(newState)
      } else {
        setColumnFilters(updaterOrValue)
      }
    },
    [columnFilters, setColumnFilters],
  )

  // Persistent global filter state
  const [globalFilter, setGlobalFilter] = useLocalStorage<string>('validator-global-filter', '')

  const table = useReactTable<Validator>({
    data: validators,
    columns,
    filterFns: {
      global: globalFilterFn,
    },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'global',
    getRowId: (validator) => String(validator.id),
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: handleSortingChange,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: handleColumnFiltersChange,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: handleColumnVisibilityChange,
    getRowCanExpand: () => true,
    getExpandedRowModel: getExpandedRowModel(),
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      globalFilter,
    },
  })

  // The following are memo-ized based on the first validator in the list changing,
  // which is a simple way to trigger re-calculation when the data re-fetches.
  // useValidators does return stable instances, so this should be sufficient.
  // Pre-filtered count of sunsetted validators
  const sunsetCount = React.useMemo(
    () => table.getPreFilteredRowModel().rows.filter((row) => isSunsetted(row.original)).length,
    [validators?.at(0)],
  )

  // Pre-filtered count of ineligible validators
  const ineligibleCount = React.useMemo(() => {
    return table
      .getPreFilteredRowModel()
      .rows.filter((row) => row.original.state.totalAlgoStaked < MIN_ELIGIBLE_STAKE).length
  }, [validators?.at(0)])

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
          <Table className="border-collapse border-spacing-0">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id} className="first:px-0 first:w-12">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <React.Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() && 'selected'}
                      className={cn({
                        'text-foreground/50': isSunsetted(row.original),
                        'border-b-0 bg-muted/25': row.getIsExpanded(),
                      })}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="first:pr-0">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {row.getIsExpanded() && (
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableCell colSpan={row.getVisibleCells().length} className="p-0">
                          <ValidatorInfoRow validator={row.original} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    {isLoading ? 'Loading...' : 'No results'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  )
}
