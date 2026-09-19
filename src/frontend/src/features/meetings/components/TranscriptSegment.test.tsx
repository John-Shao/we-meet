import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { TranscriptSegment } from './TranscriptSegment'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    type,
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
    type?: 'button' | 'submit'
  }) => (
    <button type={type ?? 'button'} disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

function show(overrides: Partial<React.ComponentProps<typeof TranscriptSegment>> = {}) {
  const onCorrect = vi.fn()
  const onRevert = vi.fn()
  render(
    <TranscriptSegment
      speaker="Ada"
      time="0:01"
      text="Hello world."
      segmentId="seg-1"
      onCorrect={onCorrect}
      onRevert={onRevert}
      {...overrides}
    />
  )
  return { onCorrect, onRevert }
}

it('offers no edit control when no handler is supplied', () => {
  // An online transcript has no revision model; a button that can only fail is
  // worse than no button.
  show({ onCorrect: undefined })
  expect(screen.queryByText('transcriptCorrection.edit')).not.toBeInTheDocument()
})

it('saves a corrected line, trimmed', () => {
  const { onCorrect } = show()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  const field = screen.getByLabelText('transcriptCorrection.edit')
  fireEvent.change(field, { target: { value: '  Hello word.  ' } })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(onCorrect).toHaveBeenCalledWith('seg-1', 'Hello word.')
})

it('will not save an unchanged line', () => {
  const { onCorrect } = show()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(onCorrect).not.toHaveBeenCalled()
})

it('will not save an emptied line', () => {
  const { onCorrect } = show()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByLabelText('transcriptCorrection.edit'), {
    target: { value: '   ' },
  })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(onCorrect).not.toHaveBeenCalled()
})

it('cancelling leaves the text alone', () => {
  const { onCorrect } = show()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByLabelText('transcriptCorrection.edit'), {
    target: { value: 'abandoned' },
  })
  fireEvent.click(screen.getByText('transcriptCorrection.cancel'))
  expect(onCorrect).not.toHaveBeenCalled()
  expect(screen.getByText('Hello world.')).toBeInTheDocument()
})

it('marks a corrected row and lets the reader compare with the original', () => {
  render(
    <TranscriptSegment
      speaker="Ada"
      time="0:01"
      text="Hello world."
      originalText="Hello word."
      isCorrected
      segmentId="seg-1"
      onCorrect={vi.fn()}
      onRevert={vi.fn()}
    />
  )
  expect(screen.getByText('transcriptCorrection.editedBadge')).toBeInTheDocument()
  expect(screen.getByText('Hello world.')).toBeInTheDocument()
  fireEvent.click(screen.getByText('transcriptCorrection.showOriginal'))
  // The recogniser's own words must be reachable, or an edit looks original.
  expect(screen.getByText('Hello word.')).toBeInTheDocument()
  expect(screen.queryByText('Hello world.')).not.toBeInTheDocument()
})

it('an uncorrected row shows no badge and no revert', () => {
  show({ originalText: 'Hello world.', isCorrected: false })
  expect(screen.queryByText('transcriptCorrection.editedBadge')).not.toBeInTheDocument()
  expect(screen.queryByText('transcriptCorrection.restore')).not.toBeInTheDocument()
})

it('reverting names the segment it applies to', () => {
  const { onRevert } = show({
    originalText: 'Hello word.',
    isCorrected: true,
  })
  fireEvent.click(screen.getByText('transcriptCorrection.restore'))
  expect(onRevert).toHaveBeenCalledWith('seg-1')
})

it('reports a failed correction instead of failing silently', () => {
  show({ editFailed: true })
  expect(screen.getByRole('alert')).toHaveTextContent('transcriptCorrection.failed')
})

it('keeps the segment id the list uses to find the active row', () => {
  show()
  expect(document.querySelector('[data-segment-id="seg-1"]')).toBeTruthy()
})
