import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExpandableText } from './expandable-text'

describe('ExpandableText', () => {
  it('expands and collapses without discarding line breaks', async () => {
    const user = userEvent.setup()
    render(<ExpandableText text={'First line\nSecond line'} limit={10} />)
    expect(screen.getByText('First lin…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText('First line Second line')).toHaveTextContent('Second line')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByText('First lin…')).toBeInTheDocument()
  })

  it('omits toggle for short text', () => {
    render(<ExpandableText text="Short" limit={10} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
