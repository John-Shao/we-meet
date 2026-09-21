import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { OriginalSearch } from './OriginalSearch'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

it('limits pasted searches to the API bound and still allows clearing', async () => {
  const user = userEvent.setup()
  const onSearch = vi.fn()
  render(<OriginalSearch onSearch={onSearch} />)
  const input = screen.getByRole('searchbox')
  await user.click(input)
  await user.paste('x'.repeat(201))
  expect(input).toHaveValue('x'.repeat(200))
  await user.keyboard('{Enter}')
  expect(onSearch).toHaveBeenLastCalledWith('x'.repeat(200))
  await user.click(screen.getByRole('button', { name: 'clearSearch' }))
  expect(input).toHaveValue('')
  expect(onSearch).toHaveBeenLastCalledWith('')
  expect(input).toHaveFocus()
})
