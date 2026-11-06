import { render, screen } from '@testing-library/react'
import { ReadFailure } from '@/components/ReadFailure'

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(`Received status ${status}`), {
    status,
    response: { status, text: JSON.stringify({ message }) },
  })
}

describe('ReadFailure', () => {
  it("says why, with the node's message below", () => {
    const error = Object.assign(new Error('ghostkit: failed'), {
      cause: httpError(503, 'the box index is incomplete'),
    })
    render(<ReadFailure title="Couldn't load changes" error={error} />)
    expect(
      screen.getByText("Couldn't load changes. The node can't serve this history right now."),
    ).toBeInTheDocument()
    expect(screen.getByText('the box index is incomplete')).toBeInTheDocument()
  })

  it('keeps the title alone for an error it cannot name', () => {
    const { container } = render(
      <ReadFailure title="Couldn't load history" error={new Error('boom')} />,
    )
    expect(container).toHaveTextContent(/^Couldn't load history$/)
  })
})
