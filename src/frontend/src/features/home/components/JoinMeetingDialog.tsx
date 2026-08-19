import { useTranslation } from 'react-i18next'
import { Field, Ul, H, P, Form, Dialog } from '@/primitives'
import { navigateTo } from '@/navigation/navigateTo'
import { isRoomValid, normalizeRoomId } from '@/features/rooms'

export const JoinMeetingDialog = () => {
  const { t } = useTranslation('home')

  // Strip the optional we-meet origin prefix, then run the input through
  // normalizeRoomId so that pasted formats like "1234 5678" or "1234-5678"
  // collapse to the canonical 8-digit slug expected by the room route.
  const sanitize = (raw: string) =>
    normalizeRoomId(raw.trim().replace(`${window.location.origin}/`, ''))

  const handleSubmit = (data: { roomId?: FormDataEntryValue }) => {
    navigateTo('room', sanitize(data.roomId as string))
  }

  const validateRoomId = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return null
    return !isRoomValid(sanitize(trimmed)) ? (
      <>
        <p>{t('joinInputError')}</p>
        <Ul>
          <li>{window.location.origin}/12345678</li>
          <li>12345678</li>
          <li>{window.location.origin}/uio-azer-jkl</li>
          <li>uio-azer-jkl</li>
        </Ul>
      </>
    ) : null
  }

  return (
    <Dialog title={t('joinMeeting')}>
      <Form onSubmit={handleSubmit} submitLabel={t('joinInputSubmit')}>
        {/* eslint-disable jsx-a11y/no-autofocus -- Focus on input when modal opens, required for accessibility */}
        <Field
          type="text"
          autoFocus
          isRequired
          name="roomId"
          label={t('joinInputLabel')}
          description={t('joinInputExample', {
            example: window.origin + '/azer-tyu-qsdf',
          })}
          validate={validateRoomId}
        />
      </Form>
      <H lvl={2}>{t('joinMeetingTipHeading')}</H>
      <P last>{t('joinMeetingTipContent')}</P>
    </Dialog>
  )
}
