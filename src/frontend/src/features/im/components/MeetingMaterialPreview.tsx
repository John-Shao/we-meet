import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  RiFileTextLine,
  RiPlayCircleLine,
  RiVolumeUpLine,
} from '@remixicon/react'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { css } from '@/styled-system/css'

/** Private previews are resolved as the viewer, never included in forwarded messages. */
export function MeetingMaterialPreview({
  recordId,
  scope,
  summaryId,
  humanId,
}: {
  recordId: string
  scope: 'record' | 'minutes'
  summaryId?: string
  humanId?: string
}) {
  const { t } = useTranslation('meetings')
  const { user } = useUser()
  const query = useQuery({
    queryKey: [
      'meeting-material-preview',
      user?.id,
      recordId,
      scope,
      summaryId,
      humanId,
    ],
    enabled: !!user,
    queryFn: async ({ signal }) => {
      const selector =
        humanId !== undefined
          ? `?human_id=${encodeURIComponent(humanId)}`
          : summaryId !== undefined
            ? `?summary_id=${encodeURIComponent(summaryId)}`
            : ''
      const value = await fetchApi<{
        role: 'reader' | 'editor' | 'manager'
        excerpt: string
        media_type: string
        media_url: string | null
        duration_ms?: number
        summary_id?: string
        human_id?: string
        identity_updated?: boolean
      }>(
        `meeting-records/${encodeURIComponent(recordId)}/collaboration/${scope}/preview/${selector}`,
        { signal, cache: 'no-store' }
      )
      if (
        (summaryId !== undefined && value.summary_id !== summaryId) ||
        (humanId !== undefined && value.human_id !== humanId)
      ) {
        throw new Error('The requested minutes version is unavailable.')
      }
      return value
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 15000,
  })
  const data = query.isError ? undefined : query.data
  return (
    <span
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
        width: '100%',
      })}
    >
      <span className={css({ color: 'primary.600', fontWeight: 'medium' })}>
        {t(`collaboration.${scope}`)}
      </span>
      <span
        className={css({
          display: 'flex',
          position: 'relative',
          flexDirection: 'column',
          alignItems: scope === 'record' ? 'center' : 'stretch',
          justifyContent: 'center',
          minHeight: '8rem',
          maxHeight: '13rem',
          overflow: 'hidden',
          background: 'greyscale.100',
          borderRadius: 'md',
          padding: 'md',
          textAlign: 'left',
          whiteSpace: 'pre-wrap',
        })}
      >
        {scope === 'minutes' ? (
          <>
            <RiFileTextLine
              size={24}
              aria-hidden
              className={css({ flexShrink: 0 })}
            />
            <span className={css({ fontSize: 'sm', lineHeight: 1.6 })}>
              {data?.excerpt || t('collaboration.minutes')}
            </span>
            {data?.identity_updated && (
              <span>{t('recordAi.identityUpdated')}</span>
            )}
          </>
        ) : (
          <>
            {data?.media_type === 'video' && data.media_url ? (
              <video
                src={data.media_url}
                muted
                playsInline
                preload="metadata"
                aria-hidden
                className={css({
                  maxHeight: '11rem',
                  width: '100%',
                  objectFit: 'contain',
                })}
              />
            ) : (
              <RiVolumeUpLine size={40} aria-hidden />
            )}
            <RiPlayCircleLine size={40} aria-hidden />
            {!!data?.duration_ms && (
              <span>
                {Math.floor(data.duration_ms / 60000)}:
                {String(Math.floor(data.duration_ms / 1000) % 60).padStart(
                  2,
                  '0'
                )}
              </span>
            )}
          </>
        )}
      </span>
      <span
        className={css({
          borderTop: '1px solid token(colors.border.subtle)',
          paddingTop: 'sm',
          textAlign: 'left',
          fontSize: 'sm',
        })}
      >
        {data
          ? t(`collaboration.viewer_${data.role}`)
          : t(query.isError ? 'collaboration.previewUnavailable' : 'loading')}
      </span>
    </span>
  )
}
