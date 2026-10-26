import { fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'

const ADDRESS = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

vi.mock('@tanstack/react-router', () => ({
  Link: React.forwardRef<
    HTMLAnchorElement,
    { to: string; params?: Record<string, string>; children?: React.ReactNode }
  >(function Link({ to, params, children, ...rest }, ref) {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    )
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    )
  }),
}))
vi.mock('@txnlab/use-wallet-react', () => {
  const account = {
    address: 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST',
    name: 'One',
  }
  return {
    useWallet: () => ({
      activeAccount: account,
      activeWallet: {
        accounts: [account],
        metadata: { name: 'Mock', icon: '' },
        disconnect: vi.fn(),
        setActiveAccount: vi.fn(),
      },
    }),
  }
})
vi.mock('@/components/WalletBalance', () => ({ WalletBalance: () => null }))
vi.mock('@/components/WalletMetadata', () => ({ WalletMetadata: () => null }))

import { ConnectedMenu } from '@/components/ConnectedMenu'

describe('ConnectedMenu', () => {
  it('links to the account staking history', async () => {
    render(<ConnectedMenu activeAddress={ADDRESS} />)
    const trigger = screen.getByRole('button')
    fireEvent.keyDown(trigger, { key: 'Enter' })

    const item = await screen.findByRole('menuitem', { name: 'Staking history' })
    expect(item).toHaveAttribute('href', `/history/${ADDRESS}`)
    // Above "Disconnect"
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent)
    expect(items.indexOf('Staking history')).toBeLessThan(
      items.findIndex((text) => text?.startsWith('Disconnect')),
    )
  })
})
