import { fireEvent, render, screen } from '@testing-library/react'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { StakersList } from '@/components/ValidatorDetails/StakersList'

const ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

const DATA = [
  {
    name: 'staker.algo',
    value: 5_000_000,
    address: ADDRESS,
    href: `/history/${ADDRESS}?round=123`,
    target: '_self',
  },
]

describe('StakersList', () => {
  beforeEach(() => navigate.mockClear())

  it('links each staker to their history, at the round on screen, in the same tab', () => {
    render(<StakersList chartData={DATA} />)
    const link = screen.getByRole('link', { name: 'staker.algo' })
    expect(link).toHaveAttribute('href', `/history/${ADDRESS}?round=123`)
    expect(link).toHaveAttribute('target', '_self')
  })

  it('routes a plain click in the app', () => {
    render(<StakersList chartData={DATA} />)
    const link = screen.getByRole('link', { name: 'staker.algo' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ to: '/history/$address', params: { address: ADDRESS } })
  })

  it('leaves a ctrl click (new tab) to the browser', () => {
    render(<StakersList chartData={DATA} />)
    // jsdom can't open the page itself
    const noNavigation = (event: Event) => event.preventDefault()
    window.addEventListener('click', noNavigation, { capture: true, once: true })
    fireEvent.click(screen.getByRole('link', { name: 'staker.algo' }), { ctrlKey: true })
    expect(navigate).not.toHaveBeenCalled()
  })
})
