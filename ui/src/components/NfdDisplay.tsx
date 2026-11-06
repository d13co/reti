import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { isNfdUnavailableError } from '@/api/nfd'
import { nfdQueryOptions, ipfsUrlQueryOptions } from '@/api/queries'
import { Nfd } from '@/interfaces/nfd'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import { useAtRound } from '@/hooks/useAtRound'
import { ellipseAddressJsx } from '@/utils/ellipseAddress'
import { getNfdAvatarUrl, getNfdProfileUrl } from '@/utils/nfd'
import { cn } from '@/utils/ui'

// 1x1 transparent PNG
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

interface NfdDisplayBaseProps {
  nfd: Nfd
  className?: string
  avatarClassName?: string
  link?: boolean
  truncate?: boolean
  tooltip?: boolean
  avatarOnly?: boolean
}

const NfdDisplayBase = React.memo(
  function NfdDisplayBase({
    nfd,
    className,
    avatarClassName,
    link = false,
    truncate = false,
    tooltip = false,
    avatarOnly = false,
  }: NfdDisplayBaseProps) {
    const originalUrl = React.useMemo(() => getNfdAvatarUrl(nfd), [nfd])
    // Which avatar failed to load: another NFD, or this one at another round, gets its own try
    const [failedUrl, setFailedUrl] = React.useState<string>()
    const imageError = failedUrl === originalUrl
    const isIpfsUrl = originalUrl.startsWith('ipfs://')

    const { data: resolvedIpfsUrl } = useQuery(ipfsUrlQueryOptions(originalUrl))

    const avatarUrl = React.useMemo(() => {
      if (imageError) {
        return TRANSPARENT_PNG
      }
      if (isIpfsUrl) {
        return resolvedIpfsUrl || TRANSPARENT_PNG
      }
      return originalUrl
    }, [originalUrl, imageError, resolvedIpfsUrl, isIpfsUrl])

    const avatar = (
      <div className={cn('relative h-6 w-6 rounded-full bg-muted', avatarClassName)}>
        <img
          src={avatarUrl}
          className="absolute inset-0 rounded-full object-cover"
          alt={nfd.name}
          onError={() => setFailedUrl(originalUrl)}
        />
      </div>
    )

    if (avatarOnly) {
      return avatar
    }

    const content = (
      <div className="flex items-center gap-x-1.5 text-sm font-semibold text-foreground">
        <div className="flex-shrink-0">{avatar}</div>
        <div className={cn({ truncate })}>{nfd.name}</div>
      </div>
    )

    const wrappedContent = link ? (
      <a
        href={getNfdProfileUrl(nfd.name)}
        target="_blank"
        rel="noreferrer"
        className={cn('link underline-offset-4', className)}
      >
        {content}
      </a>
    ) : (
      <div className={className}>{content}</div>
    )

    if (tooltip) {
      return <Tooltip content={nfd.name}>{wrappedContent}</Tooltip>
    }

    return wrappedContent
  },
  // The query keeps an unchanged NFD's object, so a new one means something shown may differ: its
  // avatar or state at another round
  (prevProps, nextProps) => {
    return (
      prevProps.nfd === nextProps.nfd &&
      prevProps.className === nextProps.className &&
      prevProps.avatarClassName === nextProps.avatarClassName &&
      prevProps.link === nextProps.link &&
      prevProps.truncate === nextProps.truncate &&
      prevProps.tooltip === nextProps.tooltip &&
      prevProps.avatarOnly === nextProps.avatarOnly
    )
  },
)

interface NfdLoadingDisplayProps {
  /** The address the NFD is for, shown until it loads; without one, "Loading…" */
  address?: string
  className?: string
  avatarClassName?: string
  truncate?: boolean
  avatarOnly?: boolean
}

/** An NFD while it loads: a spinner where its avatar goes, and the address it is for. */
function NfdLoadingDisplay({
  address,
  className,
  avatarClassName,
  truncate = false,
  avatarOnly = false,
}: NfdLoadingDisplayProps) {
  const avatar = (
    <div className={cn('grid h-6 w-6 place-items-center rounded-full bg-muted', avatarClassName)}>
      <Loading size="sm" inline className="h-2/3 w-2/3" />
    </div>
  )

  return (
    <div className={className} role="status" aria-label="Loading NFD">
      {avatarOnly ? (
        avatar
      ) : (
        <div className="flex items-center gap-x-1.5 text-sm">
          <div className="flex-shrink-0">{avatar}</div>
          <div className={cn('font-mono', { truncate })}>
            {address ? ellipseAddressJsx(address) : 'Loading…'}
          </div>
        </div>
      )}
    </div>
  )
}

type NfdDisplayProps = (
  | {
      nfd: Nfd
      nameOrId?: never
    }
  | {
      nfd?: never
      nameOrId: string | bigint
    }
) & {
  className?: string
  avatarClassName?: string
  link?: boolean
  truncate?: boolean
  tooltip?: boolean
  avatarOnly?: boolean
  /** The address to show while a `nameOrId` NFD loads */
  address?: string
}

const NfdDisplay = React.memo(function NfdDisplay({
  nfd: nfdProp,
  nameOrId,
  address,
  ...props
}: NfdDisplayProps) {
  const { round } = useAtRound()
  const { data: nfdData, isLoading, error } = useQuery(nfdQueryOptions(nameOrId || '', round))

  if (nfdProp) {
    return <NfdDisplayBase nfd={nfdProp} {...props} />
  }

  if (isLoading) {
    return (
      <NfdLoadingDisplay
        address={address}
        className={props.className}
        avatarClassName={props.avatarClassName}
        truncate={props.truncate}
        avatarOnly={props.avatarOnly}
      />
    )
  }

  // No NFDs on this node: the address, or the NFD's app id, stands in
  if (isNfdUnavailableError(error)) {
    return (
      <div className={cn('font-mono text-sm', { truncate: props.truncate }, props.className)}>
        {address ? ellipseAddressJsx(address) : nameOrId?.toString()}
      </div>
    )
  }

  if (error || !nfdData) {
    return <span className="text-sm text-red-500">Error fetching NFD</span>
  }

  return <NfdDisplayBase nfd={nfdData} {...props} />
})

export { NfdDisplay, NfdLoadingDisplay }
