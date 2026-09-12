import { LimitReachedAlertDialog } from './LimitReachedAlertDialog'
import { RecordingStateToast } from './RecordingStateToast'
import { ErrorAlertDialog } from './ErrorAlertDialog'
import { OnlineCaptureNotice } from '@/features/meetings/components/OnlineCaptureNotice'

export const RecordingProvider = () => {
  return (
    <>
      <RecordingStateToast />
      <OnlineCaptureNotice />
      <LimitReachedAlertDialog />
      <ErrorAlertDialog />
    </>
  )
}
