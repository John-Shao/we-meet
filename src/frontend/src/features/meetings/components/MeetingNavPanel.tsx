import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
  RiVidiconLine,
  RiMicLine,
  RiStickyNoteLine,
  RiSparklingLine,
  RiSettings3Line,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { IconButton } from '@/primitives'
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
      (path === '/meeting/recording' &&
        location.startsWith('/meeting/recording/')) ||
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
            borderRight: '1px solid token(colors.border.subtle)',
            backgroundColor: 'subNavBg',
            // 内边距/行距与「审批」二级导航取同一档,两个模块并排看才是一套。
            paddingY: 'lg',
            paddingX: 'md',
            display: 'flex',
            flexDirection: 'column',
            gap: 'xs',
          })}
        >
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'sm',
              marginBottom: 'sm',
              paddingX: 'sm',
            })}
          >
            <h1
              className={css({
                textStyle: 'titleMedium',
                color: 'text.primary',
                margin: 0,
              })}
            >
              {t('nav.meeting', { ns: 'shell' })}
            </h1>
            {/* 面板头动作走 IconButton:悬停/pressed/focus-visible、无障碍名与
                Tooltip 由基元一处给出,不再手搓方框热区。 */}
            <IconButton
              size="icon32"
              label={t('systemSettings.nav.meeting', { ns: 'settings' })}
              onPress={() => openSystemSettings('meeting')}
              data-testid="meeting-settings"
            >
              <RiSettings3Line size={18} aria-hidden="true" />
            </IconButton>
          </div>
          <div
            className={css({
              display: 'flex',
              flexDirection: 'column',
              gap: 'xs',
            })}
          >
            <NavRow
              icon={<RiVidiconLine size={18} aria-hidden="true" />}
              label={t('library.video', { ns: 'meetings' })}
              active={current('/meeting') === 'page'}
              dataAttr="meeting-home"
              onPress={() => navigateTo('home')}
            />
            {data?.meeting_records?.capture_audio_enabled && (
              <NavRow
                icon={<RiMicLine size={18} aria-hidden="true" />}
                label={t('library.record', { ns: 'meetings' })}
                active={current('/meeting/recording') === 'page'}
                onPress={() => navigateTo('audioRecording')}
              />
            )}
            {data?.meeting_records?.enabled && (
              <>
                <NavRow
                  icon={<RiStickyNoteLine size={18} aria-hidden="true" />}
                  label={t('library.notes', { ns: 'meetings' })}
                  active={current('/meeting/notes') === 'page'}
                  onPress={() => navigateTo('meetingNotes')}
                />
                <NavRow
                  icon={<RiSparklingLine size={18} aria-hidden="true" />}
                  label={t('library.minutes', { ns: 'meetings' })}
                  active={current('/meeting/minutes') === 'page'}
                  onPress={() => navigateTo('meetingMinutes')}
                />
              </>
            )}
          </div>
        </aside>
      </ResizablePanel>
    </>
  )
}

/**
 * 二级导航行。样式与「审批」「日历/任务/通讯录」等模块的二级导航一致:
 * 静止态**透明底 + 灰字**,只有当前项填 `selected.bg`/`selected.text`
 * —— `selected.*` 是全站二级导航/树形选中态的语义 token(见 ApprovalRoute、
 * AdminShell、DepartmentTree 等二十余处)。
 *
 * 放在这里而不是复用 Button 基元:基元各档都带自己的底色/悬停色,叠一层
 * `className` 去盖会撞上 panda-cx-atomic-order-trap(同属性原子类按样式表
 * 顺序取胜,不是书写顺序)。所以和审批一样,**布局与状态拆成三个 css()**,
 * 用 cx 叠加,谁赢是确定的。
 */
const NavRow = ({
  icon,
  label,
  active,
  dataAttr,
  onPress,
}: {
  icon: ReactNode
  label: string
  active: boolean
  dataAttr?: string
  onPress: () => void
}) => (
  <button
    type="button"
    data-attr={dataAttr}
    aria-current={active ? 'page' : undefined}
    onClick={onPress}
    className={cx(navRowBase, active ? navRowActive : navRowIdle)}
  >
    {icon}
    {label}
  </button>
)

const navRowBase = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  paddingX: 'sm',
  paddingY: 'xs',
  minHeight: 'controlHeight.compact',
  borderRadius: 'control',
  textStyle: 'bodyMedium',
  cursor: 'pointer',
  border: 'none',
  textAlign: 'left',
  width: '100%',
  transition:
    'background-color token(durations.fast), color token(durations.fast)',
  // 基元之外的手写行也必须自带焦点环 —— 此前这几行按下 Tab 是「看不见焦点」的。
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '-2px',
  },
})

const navRowIdle = css({
  color: 'text.secondary',
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'surface.muted', color: 'text.primary' },
})

const navRowActive = css({
  backgroundColor: 'selected.bg',
  color: 'selected.text',
  fontWeight: 500,
})
