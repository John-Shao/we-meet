import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RiDownloadLine } from '@remixicon/react'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import type { ApiMeetingRecord } from '../api/ApiMeetingRecord'

/** The browser streams the attachment; file bytes never accumulate in JS. */
export function RecordMediaDownload({ record }: { record: ApiMeetingRecord }) {
  const { t } = useTranslation('meetings')
  const pending = useRef<AbortController>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => () => pending.current?.abort(), [record.id])
  if (record.source_type !== 'upload' || !record.capabilities.download_media)
    return null
  const download = async () => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setFailed(false)
    try {
      const file = await fetchApi<{
        url: string
        name: string
        expires_in: number
      }>(
        `meeting-records/${encodeURIComponent(record.id)}/media/?download=true`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20_000),
          ]),
          cache: 'no-store',
        }
      )
      if (controller.signal.aborted) return
      if (
        new URL(file.url).protocol !== 'https:' ||
        !Number.isFinite(file.expires_in) ||
        file.expires_in <= 0
      )
        throw new Error('Unavailable download')
      const link = document.createElement('a')
      link.href = file.url
      link.download = file.name
      link.rel = 'noreferrer'
      document.body.append(link)
      link.click()
      link.remove()
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) {
        pending.current = undefined
        setBusy(false)
      }
    }
  }
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        icon={<RiDownloadLine size={16} aria-hidden />}
        loading={busy}
        isDisabled={busy}
        onPress={() => void download()}
      >
        {t(busy ? 'mediaDownload.preparing' : 'mediaDownload.action')}
      </Button>
      {failed && <Text role="alert">{t('mediaDownload.failed')}</Text>}
    </div>
  )
}
