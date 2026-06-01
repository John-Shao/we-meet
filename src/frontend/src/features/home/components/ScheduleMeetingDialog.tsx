import { useTranslation } from 'react-i18next'
import { Field, Form, Dialog } from '@/primitives'
import { useUser } from '@/features/auth'
import { useCreateRoom } from '@/features/rooms/api/createRoom'
import { ApiRoom } from '@/features/rooms/api/ApiRoom'
import { Input } from '@/primitives/Input'
import { useCloseDialog } from '@/primitives/useCloseDialog'
import { Label } from 'react-aria-components'
import { styled } from '@/styled-system/jsx'
import { css } from '@/styled-system/css'

const FieldWrapper = styled('div', {
  base: {
    marginBottom: 'textfield',
  },
})

const StyledLabel = styled(Label, {
  base: {
    display: 'block',
    fontSize: '0.875rem',
    marginBottom: '0.25rem',
  },
})

/**
 * Schedule-meeting dialog: meeting name + optional local datetime.
 *
 * The datetime picker is a native `<input type="datetime-local">` (no
 * tz suffix). On submit we convert it to an ISO 8601 string with the
 * user's local offset via `new Date(local).toISOString()` so the
 * backend gets an unambiguous UTC instant. Omitting the time submits
 * `scheduledAt=undefined`, which the API serializer treats as a
 * persistent room without a planned start (legacy "create later"
 * semantics — invite dialog still shows but without a "scheduled for"
 * line).
 *
 * On successful create we hand the resulting room back to the caller
 * (Home) which pops the standard LaterMeetingDialog showing the room's
 * connection details (now including scheduled_at if set).
 */
export const ScheduleMeetingDialog = ({
  onCreated,
  username,
}: {
  onCreated: (room: ApiRoom) => void
  username: string
}) => {
  const { t } = useTranslation('home', { keyPrefix: 'scheduleMeetingDialog' })
  const { t: tHome } = useTranslation('home')
  const { user } = useUser()
  const { mutateAsync: createRoom } = useCreateRoom()
  const closeDialog = useCloseDialog()

  const handleSubmit = async (data: Record<string, FormDataEntryValue>) => {
    const ownerName = (user?.full_name || username || '').trim()
    const defaultName = ownerName
      ? tHome('defaultRoomName', { user: ownerName })
      : tHome('defaultRoomNameAnonymous')
    const meetingName = String(data.meetingName || '').trim() || defaultName
    const localValue = String(data.scheduledAt || '').trim()
    // datetime-local format: "YYYY-MM-DDTHH:mm". Empty string => undefined,
    // which createRoom drops from the body.
    const scheduledAt = localValue
      ? new Date(localValue).toISOString()
      : undefined
    const room = await createRoom({
      name: meetingName,
      username,
      scheduledAt,
    })
    closeDialog?.()
    onCreated(room)
  }

  const ownerName = (user?.full_name || username || '').trim()
  const defaultRoomName = ownerName
    ? tHome('defaultRoomName', { user: ownerName })
    : tHome('defaultRoomNameAnonymous')

  return (
    <Dialog title={t('title')}>
      <Form onSubmit={handleSubmit} submitLabel={t('submit')}>
        {/* eslint-disable jsx-a11y/no-autofocus -- Focus on input when modal opens, required for accessibility */}
        <Field
          type="text"
          name="meetingName"
          label={t('nameLabel')}
          defaultValue={defaultRoomName}
          autoFocus
          isRequired
        />
        <FieldWrapper>
          <StyledLabel htmlFor="scheduledAt">{t('timeLabel')}</StyledLabel>
          <Input
            id="scheduledAt"
            name="scheduledAt"
            type="datetime-local"
            className={css({ width: '100%' })}
          />
          <p
            className={css({
              fontSize: '0.75rem',
              color: 'gray.600',
              marginTop: '0.25rem',
            })}
          >
            {t('timeHint')}
          </p>
        </FieldWrapper>
      </Form>
    </Dialog>
  )
}
