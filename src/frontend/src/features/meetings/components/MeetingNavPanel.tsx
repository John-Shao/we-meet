import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { useQueryClient } from '@tanstack/react-query'
import { useSnapshot } from 'valtio'
import {
  RiFlashlightLine,
  RiCalendarLine,
  RiAddCircleLine,
  RiMicLine,
  RiStickyNoteLine,
  RiSparklingLine,
  RiSettings3Line,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { navigateTo } from '@/navigation/navigateTo'
import { openSystemSettings } from '@/stores/systemSettings'
import {
  closeScheduleMeeting,
  openScheduleMeeting,
  scheduleMeetingStore,
} from '@/stores/scheduleMeeting'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import { usePersistentUserChoices } from '@/features/rooms/livekit/hooks/usePersistentUserChoices'
// 直接取叶子模块而不是 `@/features/rooms` 这个桶:Join 预览页要复用本面板,
// 走桶会把 rooms/index(Room 路由)拉回来,和 rooms → 本面板 形成环。
import { useCreateRoom } from '@/features/rooms/api/createRoom'
import { ResizablePanel } from '@/components/ResizablePanel'
import { CreateEventDialog } from '@/features/calendar'

/**
 * 「视频会议」的一列功能导航:标题 + 会议设置 + 两栏磁贴。
 *
 * 它是**模块级常驻栏**,不是首页专属:视频会议首页、录音、会议笔记、智能纪要,
 * 以及进会前的预览页都渲染它,所以抽在这里而不是留在 Home 路由里 —— 否则这几页
 * 点进去导航栏就消失,只能靠浏览器后退。
 *
 * 宽度交给 ResizablePanel,且与首页共用 `we-meet:meeting-sidebar-width` 这个 key:
 * 用户拖过一次,之后在哪个二级页看到都是同一个宽度。
 *
 * 关于磁贴样式(两栏 / 图标在上 / size="sm" / minHeight)的取舍见 `tileBtn` 的注释。
 */
export const MeetingNavPanel = () => {
  const { t } = useTranslation(['home', 'shell', 'capture', 'meetings'])
  const { user } = useUser()
  const { data } = useConfig()
  const { mutateAsync: createRoom } = useCreateRoom()
  const [location] = useLocation()
  const qc = useQueryClient()

  const {
    userChoices: { username },
  } = usePersistentUserChoices()

  // 预约会议 = 创建日程(与飞书一致),弹窗开关走全局 store —— 见
  // stores/scheduleMeeting.ts:路由切回 /meeting 时面板会重新挂载,
  // 局部 useState 撑不过去。
  const { open: scheduling } = useSnapshot(scheduleMeetingStore)

  /**
   * 预约会议:先回会议首页,再弹「新建日程」。
   *
   * 先回首页是因为日程建完就落在首页的预约列表里 —— 留在二级页上弹窗,
   * 用户建完看不到它去了哪。已经在 /meeting 时不再 navigate:
   * 同址再 push 一条只会让「后退」白按一下。
   */
  const handleSchedule = () => {
    if (location !== '/meeting') navigateTo('home')
    openScheduleMeeting()
  }

  // 发起会议:后端在保存时生成 8 位 slug,前端不再自造 code。
  const handleCreate = async () => {
    const owner = (user?.full_name || username || '').trim()
    const name = owner
      ? t('defaultRoomName', { user: owner })
      : t('defaultRoomNameAnonymous')
    const room = await createRoom({ name, username })
    navigateTo('room', room.slug, {
      state: { create: true, initialRoomData: room },
    })
  }

  /**
   * 当前停留的二级页高亮为 `aria-current="page"`。
   * 只给**页面**型入口标:加入会议(点进去是 /meeting/join 那一页)、录音、会议笔记、
   * 智能纪要都有停留态;快速会议是动作(点完就进会),没有停留态。
   * 这里刻意只加语义、不另做视觉选中态 —— 六个磁贴统一是浅主题色实心,再叠一层
   * 选中色需要一个新的语义角色,属于设计契约变更,没在这次改动里擅自决定。
   */
  const current = (path: string) => (location === path ? 'page' : undefined)

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
            {/* P8 设置收敛:齿轮只是快捷入口,打开系统设置定位「会议设置」节。 */}
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
          {/* 两栏磁贴(对标飞书视频会议导航):图标在上、文字在下。
              六个一律走 tertiary(浅主题色实心),不再让「快速会议」独占
              深蓝实心 —— 参考图里主次是靠图标底色区分的,不是靠按钮深浅。
              按钮数量随后端开关在 3~6 之间变化,所以用 grid 而不是写死分组,
              奇数个时最后一个自然占左栏、不拉伸。 */}
          <div
            className={css({
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '0.625rem',
              alignItems: 'stretch',
            })}
          >
            <Button
              variant="tertiary"
              size="sm"
              className={tileBtn}
              data-attr="create-meeting"
              onPress={handleCreate}
            >
              <RiFlashlightLine size={18} />
              {t('quickMeeting')}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              className={tileBtn}
              data-attr="schedule-meeting"
              onPress={handleSchedule}
            >
              <RiCalendarLine size={18} />
              {t('scheduleMeeting')}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              className={tileBtn}
              aria-current={current('/meeting/join')}
              onPress={() => navigateTo('joinMeeting')}
            >
              <RiAddCircleLine size={18} />
              {t('joinMeeting')}
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
                {t('title', { ns: 'capture' })}
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
      {scheduling && (
        <CreateEventDialog
          onClose={closeScheduleMeeting}
          onCreated={() => {
            closeScheduleMeeting()
            // 日程创建时后端自建带 scheduled_at 的 Room → 刷新预约列表。
            void qc.invalidateQueries({ queryKey: ['scheduled-meetings'] })
          }}
        />
      )}
    </>
  )
}

/**
 * 视频会议侧栏的功能磁贴:两栏网格里「图标在上、文字在下」。
 *
 * 只切主轴方向 —— Button 基元的 `justifyContent/alignItems: center` 在两个方向
 * 上都把内容摆正,图标与文字的间距也直接沿用基元自己的 `gap`(0.5rem,恰好等于
 * 存量 description 档的取值),所以这里不再补间距或字号。
 *
 * 底色走 `variant="tertiary"`(浅主题色实心),这是全站唯一一个语义正确的浅底
 * 按钮档:`action.selected.container/on-container`。**不要**改成 `primary.subtle`
 * 那种「浅底面三件套」—— panda 里它虽然能出同样的颜色,但 `primary.*` 属于调色板
 * 命名,`scripts/check-color-system.mjs` 会把它判成 legacy 用法直接失败(该脚本
 * 的正则只放行 surface/text/icon/border/action/status 这几组语义角色)。
 *
 * 尺寸走 `size="sm"` 而不是 default:default 的 `paddingX: 1rem` 两侧共吃掉 32px,
 * 侧栏拖到最小 220px 时每格只有 89px —— 16px 的「快速会议」占 64px,加上边框正好
 * 放不下、会折成两行。sm 的 `paddingX: 0.5rem` 让同样的四字标签在最小宽度下仍单行
 * (89 - 16 - 2 = 71px ≥ 64px)。`textAlign` 是长标签万一折行时的兜底。
 *
 * `minHeight` 给磁贴定高(内容只有 18 图标 + 8 间距 + 22 行高 = 48px,由它撑开):
 * 72px 减去 48px 内容与 2px 边框,上下各留 11px,磁贴才立得住;64px 那档只剩 7px,
 * 两行磁贴挤成一条,和参考图里成块的观感对不上。sm 档本来不设 minHeight,
 * 不存在覆盖冲突;也不要再顺手加 paddingY —— 会和基元的 padding 抢同一批原子类。
 */
const tileBtn = css({
  flexDirection: 'column',
  textAlign: 'center',
  minHeight: '4.5rem',
})
