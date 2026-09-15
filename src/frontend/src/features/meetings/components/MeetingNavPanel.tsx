import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
  RiVidiconLine,
  RiMicLine,
  RiStickyNoteLine,
  RiSparklingLine,
  RiSettings3Line,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { navigateTo } from '@/navigation/navigateTo'
import { openSystemSettings } from '@/stores/systemSettings'
import { useConfig } from '@/api/useConfig'
import { ResizablePanel } from '@/components/ResizablePanel'

/** Shared module navigation: video meetings, recording, records and minutes. */
export const MeetingNavPanel = () => {
  // 必须把 settings 一并列上:语言包是 resourcesToBackend 懒加载的,
  // 只写 `t(key, { ns: 'settings' })` 不会触发加载,齿轮的 title/aria-label
  // 会原地渲染成 key 字符串(systemSettings.nav.meeting)。
  const { t } = useTranslation(['shell', 'meetings', 'settings'])
  const { data } = useConfig()
  const [location] = useLocation()

  const current = (path: string) => {
    const selected =
      location === path ||
      (path === '/meeting' && location === '/meeting/join') ||
      (path === '/meeting/notes' && location.startsWith('/meeting/records/'))
    return selected ? 'page' : undefined
  }

  return (
    <>
      <ResizablePanel
        storageKey="we-meet:meeting-sidebar-width"
        defaultWidth={260}
        min={220}
        max={460}
      >
        <aside
          className={css({
            width: '100%',
            height: '100%',
            borderRight: '1px solid token(colors.greyscale.200)',
            backgroundColor: 'subNavBg',
            padding: '1.25rem 1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          })}
        >
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            })}
          >
            <h1
              className={css({
                fontSize: '1.125rem',
                fontWeight: 'bold',
                color: 'greyscale.900',
              })}
            >
              {t('nav.meeting', { ns: 'shell' })}
            </h1>
            <button
              type="button"
              onClick={() => openSystemSettings('meeting')}
              title={t('systemSettings.nav.meeting', { ns: 'settings' })}
              aria-label={t('systemSettings.nav.meeting', { ns: 'settings' })}
              data-testid="meeting-settings"
              className={css({
                width: '1.75rem',
                height: '1.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'transparent',
                color: 'greyscale.600',
                cursor: 'pointer',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              <RiSettings3Line size={16} />
            </button>
          </div>
          <div
            className={css({
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: '0.625rem',
              alignItems: 'stretch',
            })}
          >
            <Button
              variant="tertiary"
              size="sm"
              className={tileBtn}
              data-attr="meeting-home"
              aria-current={current('/meeting')}
              onPress={() => navigateTo('home')}
            >
              <RiVidiconLine size={18} />
              {t('library.video', { ns: 'meetings' })}
            </Button>
            {data?.meeting_records?.capture_audio_enabled && (
              <Button
                variant="tertiary"
                size="sm"
                className={tileBtn}
                aria-current={current('/meeting/recording')}
                onPress={() => navigateTo('audioRecording')}
              >
                <RiMicLine size={18} />
                {t('library.record', { ns: 'meetings' })}
              </Button>
            )}
            {data?.meeting_records?.enabled && (
              <>
                <Button
                  variant="tertiary"
                  size="sm"
                  className={tileBtn}
                  aria-current={current('/meeting/notes')}
                  onPress={() => navigateTo('meetingNotes')}
                >
                  <RiStickyNoteLine size={18} />
                  {t('library.notes', { ns: 'meetings' })}
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  className={tileBtn}
                  aria-current={current('/meeting/minutes')}
                  onPress={() => navigateTo('meetingMinutes')}
                >
                  <RiSparklingLine size={18} />
                  {t('library.minutes', { ns: 'meetings' })}
                </Button>
              </>
            )}
          </div>
        </aside>
      </ResizablePanel>
    </>
  )
}

const tileBtn = css({
  justifyContent: 'flex-start',
  minHeight: '3rem',
  textAlign: 'left',
  '&[aria-current="page"]': {
    outline: '2px solid',
    outlineColor: 'action.selected.on-container',
    fontWeight: 'bold',
  },
})
