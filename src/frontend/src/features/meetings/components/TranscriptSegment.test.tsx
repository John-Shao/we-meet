import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { TranscriptSegment } from './TranscriptSegment'
import { TranscriptDraftScope } from './TranscriptDraftScope'
import { useTranscriptDraftScope } from '../hooks/useTranscriptDraft'
import { ApiError } from '@/api/ApiError'

function ClearDrafts() {
  const drafts = useTranscriptDraftScope()
  return <button onClick={() => drafts?.clear()}>revoke</button>
}

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

function show(
  overrides: Partial<React.ComponentProps<typeof TranscriptSegment>> = {}
) {
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
  expect(
    screen.queryByText('transcriptCorrection.edit')
  ).not.toBeInTheDocument()
})

it('saves a corrected line, trimmed', () => {
  const { onCorrect } = show()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  const field = screen.getByLabelText('transcriptCorrection.edit')
  fireEvent.change(field, { target: { value: '  Hello word.  ' } })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(onCorrect).toHaveBeenCalledWith('seg-1', 'Hello word.', 0)
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
  expect(
    screen.getByText('transcriptCorrection.editedBadge')
  ).toBeInTheDocument()
  expect(screen.getByText('Hello world.')).toBeInTheDocument()
  fireEvent.click(screen.getByText('transcriptCorrection.showOriginal'))
  // The recogniser's own words must be reachable, or an edit looks original.
  expect(screen.getByText('Hello word.')).toBeInTheDocument()
  expect(screen.queryByText('Hello world.')).not.toBeInTheDocument()
})

it('an uncorrected row shows no badge and no revert', () => {
  show({ originalText: 'Hello world.', isCorrected: false })
  expect(
    screen.queryByText('transcriptCorrection.editedBadge')
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText('transcriptCorrection.restore')
  ).not.toBeInTheDocument()
})

it('reverting names the segment it applies to', () => {
  const { onRevert } = show({
    originalText: 'Hello word.',
    isCorrected: true,
  })
  fireEvent.click(screen.getByText('transcriptCorrection.restore'))
  expect(onRevert).toHaveBeenCalledWith('seg-1', 0)
})

it('reports a failed correction instead of failing silently', () => {
  show({ editFailed: true })
  expect(screen.getByRole('alert')).toHaveTextContent(
    'transcriptCorrection.failed'
  )
})

it('keeps the segment id the list uses to find the active row', () => {
  show()
  expect(document.querySelector('[data-segment-id="seg-1"]')).toBeTruthy()
})

it('keeps the draft and its opening version through a refresh and a failed save', async () => {
  let reject!: (reason: unknown) => void
  const onCorrect = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  const props = {
    speaker: 'Ada',
    time: '0:01',
    text: 'Before',
    segmentId: 'seg-1',
    correctionRevision: 2,
    onCorrect,
  }
  const view = render(<TranscriptSegment {...props} />)
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'My draft' },
  })
  view.rerender(
    <TranscriptSegment
      {...props}
      text="Someone else's edit"
      correctionRevision={3}
    />
  )
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(onCorrect).toHaveBeenCalledWith('seg-1', 'My draft', 2)
  expect(screen.getByRole('textbox')).toHaveValue('My draft')
  expect(screen.getByRole('textbox')).toBeDisabled()
  await act(async () => reject(new ApiError(409, {})))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'transcriptCorrection.conflict'
  )
  expect(screen.getByRole('textbox')).toHaveValue('My draft')
  expect(screen.getByRole('textbox')).not.toBeDisabled()
  fireEvent.click(screen.getByText('transcriptCorrection.cancel'))
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  expect(screen.getByRole('textbox')).toHaveValue("Someone else's edit")
})

it('keeps pending and failed writes attached to the same draft after the row remounts', async () => {
  let reject!: (reason: unknown) => void
  const onCorrect = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  const content = (generation: number) => (
    <TranscriptDraftScope>
      <TranscriptSegment
        key={generation}
        speaker="Ada"
        time="0:01"
        segmentId="s"
        text="Original"
        correctionRevision={generation}
        onCorrect={onCorrect}
      />
    </TranscriptDraftScope>
  )
  const view = render(content(1))
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Retained draft' },
  })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  view.rerender(content(2))
  expect(screen.getByRole('textbox')).toHaveValue('Retained draft')
  expect(screen.getByRole('textbox')).toBeDisabled()
  await act(async () => reject(new ApiError(409, {})))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'transcriptCorrection.conflict'
  )
  expect(screen.getByRole('textbox')).not.toBeDisabled()
  expect(onCorrect).toHaveBeenCalledWith('s', 'Retained draft', 1)
})

it('does not revive cleared drafts when a revoked request finishes late', async () => {
  let reject!: (reason: unknown) => void
  const onCorrect = () =>
    new Promise((_, fail) => {
      reject = fail
    })
  render(
    <TranscriptDraftScope>
      <ClearDrafts />
      <TranscriptSegment
        speaker="Ada"
        time="0:01"
        segmentId="s"
        text="Original"
        onCorrect={onCorrect}
      />
    </TranscriptDraftScope>
  )
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Private draft' },
  })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  fireEvent.click(screen.getByText('revoke'))
  await act(async () => reject(new ApiError(403, {})))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  expect(screen.getByRole('textbox')).toHaveValue('Original')
})

it('cannot save a retained draft after edit permission is removed', () => {
  const props = {
    speaker: 'Ada',
    time: '0:01',
    segmentId: 's',
    text: 'Original',
  }
  const view = render(<TranscriptSegment {...props} onCorrect={vi.fn()} />)
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Private draft' },
  })
  view.rerender(<TranscriptSegment {...props} />)
  expect(screen.getByText('transcriptCorrection.save')).toBeDisabled()
  expect(screen.getByRole('textbox')).toHaveValue('Private draft')
})

it('only closes the editor after the write resolves', async () => {
  let resolve!: () => void
  show({
    onCorrect: () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  })
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fixed' } })
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  expect(screen.getByRole('textbox')).toHaveValue('Fixed')
  await act(async () => resolve())
  await waitFor(() =>
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  )
})
