import { RiVidiconLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { navigateTo } from '@/navigation/navigateTo'
import { parseMeetingCard } from './meetingCard'

/** Compact joinable meeting snapshot; forwarding preserves the original room. */
export const MeetingCardMessage = ({ body }: { body: string }) => {
  const { t, i18n } = useTranslation('im')
  const card = parseMeetingCard(body)
  if (!card)
    return <span className={fallbackCls}>{t('preview.meeting')}</span>

  const when = card.scheduled_at
    ? new Intl.DateTimeFormat(i18n.language || undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(card.scheduled_at))
    : null
  return (
    <button
      type="button"
      onClick={() => navigateTo('room', card.slug)}
      data-testid="im-msg-meeting-card"
      className={css({
        display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '0.35rem',
        minWidth: '240px', maxWidth: '320px', textAlign: 'left', backgroundColor: 'primary.50',
        border: '1px solid token(colors.primary.200)', borderRadius: '0.75rem',
        paddingX: '0.875rem', paddingY: '0.625rem', cursor: 'pointer',
        _hover: { backgroundColor: 'primary.100' },
      })}
    >
      <span className={css({ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 'medium', color: 'greyscale.900' })}>
        <RiVidiconLine size={17} className={css({ color: 'primary.600' })} />
        <span className={css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>{card.title}</span>
      </span>
      <span className={css({ fontSize: '0.8125rem', color: 'greyscale.700' })}>
        {card.status === 'ongoing'
          ? t('meetingCard.ongoing', { defaultValue: '进行中' })
          : when || t('meetingCard.scheduled', { defaultValue: '已预约会议' })}
      </span>
      <span className={css({ fontSize: '0.75rem', color: 'primary.700', fontWeight: 'medium', textAlign: 'right' })}>{t('meetingCard.join', { defaultValue: '加入会议' })}</span>
    </button>
  )
}

const fallbackCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
