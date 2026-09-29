import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/utils/formatDuration'
import { useConfig } from '@/api/useConfig'

export const useHumanizeRecordingMaxDuration = () => {
  const { data } = useConfig()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language

  return useMemo(() => {
    if (!data?.recording?.max_duration) return

    return formatDuration(data.recording.max_duration, language, {
      delimiter: ' ',
    })
  }, [data, language])
}
