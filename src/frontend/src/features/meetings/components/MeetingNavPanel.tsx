import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
  RiArrowLeftDoubleLine,
  RiLayoutLeftLine,
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

/** 左栏收起态跨路由持久化(与通讯录同一套 storage 约定)。 */
const NAV_COLLAPSED_KEY = 'we-meet:meeting-nav-collapsed'

const readCollapsed = () => {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1'
  } catch {
    // 隐私模式:这次会话里仍然能收起/展开,只是不记住。
    return false
  }
}

/** Shared module navigation: video meetings, recording, records and minutes. */
export const MeetingNavPanel = () => {
  // 必须把 settings 一并列上:语言包是 resourcesToBackend 懒加载的,
  // 只写 `t(key, { ns: 'settings' })` 不会触发加载,齿轮的 title/aria-label
  // 会原地渲染成 key 字符串(systemSettings.nav.meeting)。
  const { t } = useTranslation(['shell', 'meetings', 'settings'])
  const { data } = useConfig()
  const [location] = useLocation()
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, previous ? '0' : '1')
      } catch {
        // 隐私模式:这次会话里仍然能收起/展开,只是不记住。
      }
      return !previous
    })
  }

  const current = (path: string) => {
    const selected =
      location === path ||
      (path === '/meeting/recording' &&
        location.startsWith('/meeting/recording/')) ||
      (path === '/meeting/notes' && location.startsWith('/meeting/records/'))
    return selected ? 'page' : undefined
  }

  // 收起态:只留一条 36px 窄条,把 260px 还给正文;「展开」按钮就在窄条里 ——
  // 与通讯录左栏同一套(那边收起后也是留窄条,任何视图下都找得到展开入口)。
  if (collapsed)
    return (
      <div className={navStripCls}>
        <IconButton
          size="icon28"
          label={t('library.showNav')}
          onPress={toggleCollapsed}
          data-testid="meeting-nav-expand"
        >
          <RiLayoutLeftLine size={16} aria-hidden="true" />
        </IconButton>
      </div>
    )

  return (
    <>
      <ResizablePanel
        storageKey="we-meet:meeting-sidebar-width"
        defaultWidth={260}
        min={220}
        max={460}
      >
        <aside className={asideCls}>
          {/* 栏头几何/字号与「通讯录」二级导航的栏头逐项对齐(2026-09-17):
              paddingX 1rem + paddingY 0.75rem、16px bold 标题、右端一颗 28px 的
              收起按钮。内边距放在这一行而不是 aside 上,标题的左缘才与导航行
              (容器 8 + 行内 8 = 16px)齐平。 */}
          <div className={headerCls}>
            <h2 className={panelTitleCls}>
              {t('nav.meeting', { ns: 'shell' })}
            </h2>
            {/* 面板头动作走 IconButton:悬停/pressed/focus-visible、无障碍名与
                Tooltip 由基元一处给出,不再手搓方框热区。 */}
            <div className={headerActionsCls}>
              <IconButton
                size="icon28"
                label={t('systemSettings.nav.meeting', { ns: 'settings' })}
                onPress={() => openSystemSettings('meeting')}
                data-testid="meeting-settings"
              >
                <RiSettings3Line size={16} aria-hidden="true" />
              </IconButton>
              {/* 收起整栏:与通讯录同一位置(栏头最右)、同一档盒子。 */}
              <IconButton
                size="icon28"
                label={t('library.hideNav')}
                onPress={toggleCollapsed}
                data-testid="meeting-nav-collapse"
              >
                <RiArrowLeftDoubleLine size={16} aria-hidden="true" />
              </IconButton>
            </div>
          </div>
          <div className={rowsCls}>
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

/**
 * 左栏本体与栏头。
 *
 * 栏头几何/字号以「通讯录」二级导航为基准(`ContactsSidebar` 的 header):
 * `paddingX: 1rem` + `paddingY: 0.75rem`、`space-between`、标题 16px bold。
 * aside **不带内边距** —— 内边距由栏头与导航行两个容器各自带,标题的左缘才和
 * 导航行文字(容器 8 + 行内 8 = 16px)齐平,与通讯录一致。
 */
const asideCls = css({
  width: '100%',
  height: '100%',
  borderRight: '1px solid token(colors.border.subtle)',
  backgroundColor: 'subNavBg',
  display: 'flex',
  flexDirection: 'column',
})

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'sm',
  paddingX: 'lg',
  paddingY: 'md',
})

const panelTitleCls = css({
  textStyle: 'titleMedium',
  fontWeight: 'bold',
  color: 'text.primary',
  margin: 0,
})

const headerActionsCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'xxs',
})

const rowsCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  paddingX: 'sm',
})

/** 收起后的窄条:宽度、上边距与通讯录那条一致,底色跟着二级导航栏走。 */
const navStripCls = css({
  flexShrink: 0,
  width: '36px',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 'md',
  borderRight: '1px solid token(colors.border.subtle)',
  backgroundColor: 'subNavBg',
})
