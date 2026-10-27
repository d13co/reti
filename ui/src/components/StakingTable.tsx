import { Link } from '@tanstack/react-router'
import {
  ColumnDef,
  ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  Row,
  SortingState,
  Table as ReactTable,
  useReactTable,
  VisibilityState,
} from '@tanstack/react-table'
import { useWallet } from '@txnlab/use-wallet-react'
import { useViewedTime, useWriteAddress } from '@/hooks/useAtRound'
import { Ban, History, MessageCircleWarning, MoreHorizontal, Sunset } from 'lucide-react'
import * as React from 'react'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { ClaimTokens } from '@/components/ClaimTokens'
import { DataTableColumnHeader } from '@/components/DataTableColumnHeader'
import { SimulateEpochDropdownItem } from '@/components/DevDropdownItems'
import { Loading } from '@/components/Loading'
import { NfdDisplay } from '@/components/NfdDisplay'
import { Tooltip } from '@/components/Tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { StakerValidatorData } from '@/interfaces/staking'
import { Validator } from '@/interfaces/validator'
import { useValidatorModals } from '@/providers/ValidatorModalsProvider'
import {
  calculateRewardEligibility,
  canManageValidator,
  isStakingDisabled,
  isSunsetted,
  isSunsetting,
  isUnstakingDisabled,
} from '@/utils/contracts'
import { dayjs } from '@/utils/dayjs'
import { ellipseAddressJsx } from '@/utils/ellipseAddress'
import { formatAssetAmount } from '@/utils/format'
import { globalFilterFn } from '@/utils/table'
import { cn } from '@/utils/ui'

interface StakingTableProps {
  validators: Validator[]
  stakesByValidator: StakerValidatorData[]
  isLoading: boolean
  constraints: Constraints
}

/** What the cells read that changes more often than the columns should be rebuilt */
interface StakingTableMeta {
  validatorsById: Map<bigint, Validator>
}

function validatorOf(
  table: ReactTable<StakerValidatorData>,
  validatorId: bigint,
): Validator | undefined {
  return (table.options.meta as StakingTableMeta).validatorsById.get(BigInt(validatorId))
}

/**
 * Memoized: the dashboard re-renders for every batch of enrichment data, and this table should
 * only follow when its own props change.
 */
export const StakingTable = React.memo(function StakingTable({
  validators,
  stakesByValidator,
  isLoading,
  constraints,
}: StakingTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})

  // Stable openers, so the columns don't depend on modal state
  const { openAddStake, openUnstake } = useValidatorModals()

  const { activeAddress } = useWallet()
  const writeAddress = useWriteAddress()
  // Re-renders when a past round's time lands, which the sunset checks in the cells read
  useViewedTime()

  // Validators change with every batch of enrichment data, so the cells look them up through the
  // table's meta rather than closing over them
  const meta = React.useMemo<StakingTableMeta>(
    () => ({ validatorsById: new Map(validators.map((v) => [BigInt(v.id), v])) }),
    [validators],
  )

  // Column definitions. Memoized, and every dependency must be referentially stable:
  // `flexRender` renders each `cell` as a component, so a new column array gives every cell a
  // new component type and React remounts the whole table body (tooltips and open menus too).
  const columns = React.useMemo<ColumnDef<StakerValidatorData>[]>(
    () => [
      {
        id: 'validator',
        accessorFn: (row) => row.validatorId,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Validator" />,
        cell: ({ row, table }) => {
          const validator = validatorOf(table, row.original.validatorId)

          if (!validator) {
            return 'Unknown Validator'
          }

          const nfdAppId = validator.config.nfdForInfo
          return (
            <div className="flex items-center gap-x-2">
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

              <Link
                to="/validators/$validatorId"
                params={{
                  validatorId: String(row.original.validatorId),
                }}
                className="link underline-offset-4"
              >
                {nfdAppId > 0 ? (
                  <NfdDisplay nameOrId={nfdAppId} address={validator.config.owner} />
                ) : (
                  <span className="font-mono whitespace-nowrap">
                    {ellipseAddressJsx(validator.config.owner)}
                  </span>
                )}
              </Link>
            </div>
          )
        },
        footer: ({ table }) => (
          <span className="whitespace-nowrap">
            Total{' '}
            <span className="font-normal text-muted-foreground">
              ({table.getRowModel().rows.length} validators)
            </span>
          </span>
        ),
      },
      {
        accessorKey: 'balance',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Balance" />,
        cell: ({ row }) => (
          <AlgoDisplayAmount
            amount={row.original.balance}
            microalgos
            mutedRemainder
            className="font-mono"
          />
        ),
        footer: ({ table }) => (
          <AlgoDisplayAmount
            amount={sumOf(table.getRowModel().rows, 'balance')}
            microalgos
            mutedRemainder
            className="font-mono"
          />
        ),
      },
      {
        accessorKey: 'totalRewarded',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Total Rewarded" />,
        cell: ({ row }) => (
          <AlgoDisplayAmount
            amount={row.original.totalRewarded}
            microalgos
            mutedRemainder
            className="font-mono"
          />
        ),
        footer: ({ table }) => (
          <AlgoDisplayAmount
            amount={sumOf(table.getRowModel().rows, 'totalRewarded')}
            microalgos
            mutedRemainder
            className="font-mono"
          />
        ),
      },
      {
        accessorKey: 'rewardTokenBalance',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Token Balance" />,
        cell: ({ row, table }) => {
          const validator = validatorOf(table, row.original.validatorId)
          if (!validator?.rewardToken) {
            return <span className="text-muted-foreground">--</span>
          }
          return (
            <span className="font-mono">
              {formatAssetAmount(validator.rewardToken, row.original.rewardTokenBalance, {
                unitName: true,
              })}
            </span>
          )
        },
      },
      {
        accessorKey: 'nextEpochEligible',
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Reward Eligibility" />
        ),
        cell: ({ row, table }) => {
          const stakerValidatorData = row.original
          const validator = validatorOf(table, stakerValidatorData.validatorId)
          const { epochRoundLength } = validator?.config || {}

          const allPoolsEligibility = stakerValidatorData.pools.map((poolData) => {
            const eligibility = calculateRewardEligibility(
              epochRoundLength,
              poolData.lastPayout,
              poolData.entryRound,
            )
            return eligibility
          })

          // Take last pool's eligibility %
          const lastPoolEligibility = allPoolsEligibility.pop()
          return (
            <span className="whitespace-nowrap">
              {lastPoolEligibility !== null ? `${lastPoolEligibility || 0}%` : '--'}
            </span>
          )
        },
      },
      {
        id: 'actions',
        cell: ({ row, table }) => {
          const validator = validatorOf(table, row.original.validatorId)

          if (!validator || !writeAddress) return null

          const stakingDisabled = isStakingDisabled(writeAddress, validator, constraints)
          const unstakingDisabled = isUnstakingDisabled(writeAddress, validator, stakesByValidator)
          const canManage = canManageValidator(writeAddress, validator)

          const isDevelopment = process.env.NODE_ENV === 'development'
          const canSimulateEpoch = isDevelopment && canManage

          return (
            <div className="flex items-center justify-end gap-x-2 ml-2">
              <Button
                size="sm"
                className={cn({ hidden: isSunsetted(validator) })}
                onClick={() => openAddStake(validator)}
                disabled={stakingDisabled}
              >
                Stake
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openUnstake(validator)}
                disabled={unstakingDisabled}
              >
                Unstake
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 p-0">
                    <span className="sr-only">Open menu</span>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => openAddStake(validator)}
                      disabled={stakingDisabled}
                    >
                      Stake
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => openUnstake(validator)}
                      disabled={unstakingDisabled}
                    >
                      Unstake
                    </DropdownMenuItem>

                    {validator.rewardToken && (
                      <ClaimTokens
                        validator={validator}
                        rewardTokenBalance={row.original.rewardTokenBalance}
                      />
                    )}
                  </DropdownMenuGroup>

                  {canSimulateEpoch && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <SimulateEpochDropdownItem
                          validator={validator}
                          pools={row.original.pools}
                          writeAddress={writeAddress}
                          disabled={unstakingDisabled}
                        />
                      </DropdownMenuGroup>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [constraints, writeAddress, stakesByValidator, openAddStake, openUnstake],
  )

  const table = useReactTable({
    data: stakesByValidator,
    columns,
    meta,
    filterFns: {
      global: globalFilterFn,
    },
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
    },
  })

  return (
    <>
      <div>
        <div className="flex items-center gap-x-2 py-3">
          <h2 className="flex flex-1 items-center my-1 text-lg font-semibold">
            My Stakes {activeAddress && isLoading && <Loading size="sm" inline className="ml-3" />}
          </h2>
          {activeAddress && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/history/$address" params={{ address: activeAddress }}>
                <History className="mr-1.5 h-4 w-4" aria-hidden />
                History
              </Link>
            </Button>
          )}
        </div>
        {!activeAddress ? (
          <Alert className="max-w-md">
            <MessageCircleWarning className="h-5 w-5 -mt-1" />
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              Connect a wallet to manage your staking positions.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="rounded-md border">
            <Table className="border-collapse border-spacing-0">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      return (
                        <TableHead key={header.id} className={cn('first:px-4')}>
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
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className={cn('first:px-4')}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns.length} className="h-24 text-center">
                      {isLoading ? 'Loading...' : 'No results'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {/* A total only adds anything over two or more stakes */}
              {table.getRowModel().rows.length > 1 && (
                <TableFooter>
                  {table.getFooterGroups().map((footerGroup) => (
                    <TableRow key={footerGroup.id} className="hover:bg-transparent">
                      {footerGroup.headers.map((header) => (
                        <TableCell key={header.id} className={cn('first:px-4')}>
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.footer, header.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableFooter>
              )}
            </Table>
          </div>
        )}
      </div>
    </>
  )
})

/** A bigint column's total over the rows shown */
function sumOf(rows: Row<StakerValidatorData>[], key: 'balance' | 'totalRewarded'): bigint {
  return rows.reduce((total, row) => total + row.original[key], 0n)
}
