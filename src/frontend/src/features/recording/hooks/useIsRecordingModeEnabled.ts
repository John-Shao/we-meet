import { RecordingMode } from '../types'
import { RECORDING_ENTRY_ENABLED } from '../featureFlag'
import { useConfig } from '@/api/useConfig'

export const useIsRecordingModeEnabled = (mode: RecordingMode) => {
  const { data } = useConfig()

  return (
    RECORDING_ENTRY_ENABLED &&
    data?.recording?.is_enabled &&
    data?.recording?.available_modes?.includes(mode)
  )
}
