import { useState } from 'react'
import { RiShareForwardLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { MeetingShareDialog } from '@/features/meetings/components/MeetingShareDialog'
import { useRoomData } from '../../hooks/useRoomData'

/** Meeting-room entry point for sharing the currently ongoing meeting. */
export const MeetingShareButton = ({
  onPress,
  description = false,
}: {
  onPress?: () => void
  description?: boolean
}) => {
  const { t } = useTranslation('rooms')
  const room = useRoomData()
  const [open, setOpen] = useState(false)
  if (!room) return null
  return (
    <>
      <Button
        square={!description}
        variant="primaryTextDark"
        aria-label={t('controls.share')}
        tooltip={t('controls.share')}
        description={description}
        onPress={() => {
          onPress?.()
          setOpen(true)
        }}
        data-testid="room-share-meeting"
      >
        <RiShareForwardLine />
      </Button>
      {open && (
        <MeetingShareDialog
          meeting={{
            id: room.id,
            slug: room.slug,
            name: room.name,
            status: 'ongoing',
            scheduledAt: room.scheduled_at,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
