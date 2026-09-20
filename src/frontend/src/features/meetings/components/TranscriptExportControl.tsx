import { useTranslation } from 'react-i18next'

import { apiUrl } from '@/api/apiUrl'
import { css } from '@/styled-system/css'

/**
 * Download the transcript as a file.
 *
 * Plain `<a download>` rather than a fetch that rebuilds a blob: the response is
 * a file stream, and re-implementing it in JS would only redo what the browser
 * already does. The endpoint authorises from the session, so no header work is
 * needed here.
 *
 * The selector is `as`, not `format`: DRF reserves `?format=` for content
 * negotiation, and a URL using it never reaches the view.
 */
const FORMATS = [
  { id: 'txt', label: 'TXT' },
  { id: 'srt', label: 'SRT' },
  { id: 'vtt', label: 'VTT' },
] as const

const linkCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  padding: 'xs sm',
  borderRadius: 'control',
  textStyle: 'labelMedium',
  color: 'text.link',
  textDecoration: 'none',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: { outline: '2px solid token(colors.border.focus)' },
})

export function TranscriptExportControl({ recordId }: { recordId: string }) {
  const { t } = useTranslation('meetings')
  return (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: 'xs',
        flexWrap: 'wrap',
      })}
    >
      <span
        className={css({ color: 'text.secondary', textStyle: 'labelMedium' })}
      >
        {t('transcriptExport.label')}
      </span>
      {FORMATS.map((format) => (
        <a
          key={format.id}
          className={linkCls}
          href={apiUrl(
            `meeting-records/${recordId}/transcript-export/?as=${format.id}`
          )}
          download
          // The format is the accessible name; "TXT" alone is ambiguous in a list.
          aria-label={t('transcriptExport.download', { format: format.label })}
        >
          {format.label}
        </a>
      ))}
    </div>
  )
}
