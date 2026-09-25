import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { TranscriptExportControl } from './TranscriptExportControl'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { format?: string }) =>
      options?.format ? `${key}:${options.format}` : key,
  }),
}))

async function show() {
  render(<TranscriptExportControl recordId={recordId} />)
  await userEvent.click(
    screen.getByRole('button', { name: 'transcriptExport.label' })
  )
}

const recordId = '11111111-1111-4111-8111-111111111111'

it('offers one download per supported format', async () => {
  await show()
  for (const format of ['TXT', 'SRT', 'VTT']) {
    expect(
      screen.getByRole('menuitem', {
        name: `transcriptExport.download:${format}`,
      })
    ).toBeInTheDocument()
  }
})

it('points each link at the export endpoint with the `as` selector', async () => {
  await show()
  for (const format of ['txt', 'srt', 'vtt']) {
    const link = screen.getByRole('menuitem', {
      name: `transcriptExport.download:${format.toUpperCase()}`,
    })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain(`/meeting-records/${recordId}/transcript-export/`)
    // `format` is reserved by DRF for negotiation, so using it would 404.
    expect(href).toContain(`?as=${format}`)
    expect(href).not.toContain('format=')
  }
})

it('marks each link as a download so the browser saves rather than navigates', async () => {
  await show()
  for (const link of screen.getAllByRole('menuitem')) {
    expect(link).toHaveAttribute('download')
  }
})

it('names the format, not just the extension, for a screen reader', async () => {
  // Accessible names include the selected format.
  await show()
  expect(
    screen.getByRole('menuitem', { name: 'transcriptExport.download:TXT' })
  ).toBeInTheDocument()
})
