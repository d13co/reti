import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'

vi.mock('@/hooks/useAtRound', () => ({ useAtRound: () => ({ round: undefined }) }))
// Never answers, so the NFD stays loading
vi.mock('@/api/nfd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/nfd')>()),
  fetchNfd: () => new Promise(() => {}),
}))

import { NfdDisplay, NfdLoadingDisplay } from '@/components/NfdDisplay'

const ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

describe('NFD loading display', () => {
  it('shows the address with a spinner in place of the avatar', () => {
    render(<NfdLoadingDisplay address={ADDRESS} />)
    const status = screen.getByRole('status', { name: 'Loading NFD' })
    expect(status).toHaveTextContent('AAAAAA…Y5HFKQ')
    expect(status.querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('says loading without an address', () => {
    render(<NfdLoadingDisplay />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  })

  it('is what an NFD read by id shows while it loads', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NfdDisplay nameOrId={1013764620n} address={ADDRESS} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('status', { name: 'Loading NFD' })).toHaveTextContent('AAAAAA…Y5HFKQ')
  })
})
