/**
 * "My recent meetings" — appears on the home page after sign-in.
 *
 * Lists meetings (Rooms) the user joined that have a Summary, newest
 * first. Each card links to /meetings/<uuid>. Hidden on the logged-out
 * home; renders nothing (not a placeholder) when the list is empty so
 * brand-new users don't see an empty section.
 */

import { useState } from 'react'

import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { H, Text } from '@/primitives'
import { navigateTo } from '@/navigation/navigateTo'

import { useRecentMeetings } from '../api/fetchMeeting'

// Show a short list by default; the backend already caps the feed at 20.
const COLLAPSED_COUNT = 5

const formatRelativeTime = (iso: string, locale: string) => {
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return iso
  }
}

export const RecentMeetingsList = ({ enabled }: { enabled: boolean }) => {
  const { t, i18n } = useTranslation('meetings')
  const { data, isLoading } = useRecentMeetings(enabled)
  const [expanded, setExpanded] = useState(false)

  if (!enabled) return null
  if (isLoading) return null
  if (!data || data.length === 0) return null

  const canToggle = data.length > COLLAPSED_COUNT
  const visible = expanded ? data : data.slice(0, COLLAPSED_COUNT)

  return (
    <div
      className={css({
        width: '100%',
        maxWidth: '30rem',
        marginTop: '2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      })}
    >
      <H lvl={3} margin={false}>
        {t('home.recentTitle')}
      </H>
      <ul
        className={css({
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        {visible.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => navigateTo('meetingDetail', m.id)}
              className={css({
                width: '100%',
                textAlign: 'left',
                border: '1px solid',
                borderColor: 'gray.300',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                backgroundColor: 'white',
                cursor: 'pointer',
                transition: 'background-color 0.15s',
                _hover: { backgroundColor: 'gray.100' },
              })}
            >
              <div className={css({ fontWeight: 500 })}>
                {m.name || t('home.untitled')}
              </div>
              {m.summary_updated_at && (
                <Text
                  className={css({
                    fontSize: '0.8rem',
                    color: 'gray.600',
                    marginTop: '0.125rem',
                  })}
                >
                  {formatRelativeTime(m.summary_updated_at, i18n.language)}
                </Text>
              )}
            </button>
          </li>
        ))}
      </ul>
      {canToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={css({
            alignSelf: 'center',
            marginTop: '0.25rem',
            padding: '0.25rem 0.5rem',
            background: 'none',
            border: 'none',
            color: 'primary.700',
            fontSize: '0.85rem',
            cursor: 'pointer',
            _hover: { textDecoration: 'underline' },
          })}
        >
          {expanded
            ? t('home.collapse')
            : t('home.showAll', { count: data.length })}
        </button>
      )}
    </div>
  )
}
