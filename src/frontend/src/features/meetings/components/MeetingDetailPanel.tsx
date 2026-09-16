import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiHashtag,
  RiLinkM,
  RiShareForwardLine,
  RiTimeLine,
  RiVidiconLine,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { linkBtnCls } from '@/styles/controls'
import { Button, IconButton } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { navigateTo } from '@/navigation/navigateTo'
import { useConfirm } from '@/components/ConfirmProvider'
import { useDeleteRoom } from '@/features/rooms/api/deleteRoom'
import { MeetingShareDialog } from './MeetingShareDialog'
import { useMeetingRoom } from '../api/fetchMeeting'
import { MeetingRecordLinks } from './MeetingRecordLinks'
import { useVideoSession } from '../api/videoMeetings'
import { rowMeta } from './libraryStyles'

/** 8/9/6 位会议号按组分隔(与 App 端 formatSlug 同口径)。 */
const formatSlugDigits = (slug: string): string => {
  const digits = slug.replace(/\D/g, '')
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`
  if (digits.length === 9)
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
  if (digits.length === 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`
  return slug
}

/** 会议列表选中项(预约 / 历史共用的展示子集)。 */
export interface MeetingSelection {
  sessionId?: string | null
  sessionStatus?: 'pending' | 'active' | 'ended'
  kind: 'scheduled' | 'recent'
  id: string
  name: string
  slug: string | null
  /** scheduled → scheduled_at;recent → started_at。 */
  timeIso: string | null
  /**
   * 我是否是这场会的房主。列表混着「我创建的」和「我只是参会的」,而删除仅
   * 房主可做(后端 DELETE → is_owner),不收敛的话参会者点了吃 403。
   * scheduled 取 `is_administrable`,recent 取新增的 `is_owner`。
   */
  canManage: boolean
  /**
   * 关联日程 id;有则详情统一走「日程详情」(一场会一个详情页),
   * 无(快速会议/存量裸预约/历史会议)才用本面板。
   */
  eventId?: string | null
}

/**
 * P8 会议详情右面板(对标飞书):点预约/历史会议行打开,所有操作收进
 * 面板 —— 进入会议 / 复制会议号与链接 / 查看会议纪要(历史)/ 删除。
 * 列表行本身只负责选中,不再放行内按钮。
 */
export const MeetingDetailPanel = ({
  selection,
  onClose,
}: {
  selection: MeetingSelection
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('meetings')
  const { t: tRoom } = useTranslation('rooms', { keyPrefix: 'join' })
  const { confirm: askConfirm } = useConfirm()
  const { mutate: deleteRoom } = useDeleteRoom()
  const [copied, setCopied] = useState<'id' | 'link' | null>(null)
  const [sharing, setSharing] = useState(false)
  const [joining, setJoining] = useState(false)
  const meetingRoom = useMeetingRoom(selection.id)
  const session = useVideoSession(selection.id, selection.sessionId)
  const isClosed =
    (session.data?.status ?? selection.sessionStatus) === 'ended' ||
    !!meetingRoom.data?.closed_at
  const canJoin =
    !!meetingRoom.data?.slug &&
    !isClosed &&
    !meetingRoom.isError &&
    (!selection.sessionId || session.data?.status === 'active') &&
    !session.isError
  const activeSelection = useRef<string | null>(selection.id)

  useEffect(() => {
    activeSelection.current = selection.id
    setJoining(false)
    return () => {
      activeSelection.current = null
    }
  }, [selection.id])

  const handleJoin = async () => {
    if (!canJoin || joining) return
    setJoining(true)
    try {
      const latest = await meetingRoom.refetch()
      const latestSession = selection.sessionId ? await session.refetch() : null
      if (activeSelection.current !== selection.id) return
      if (
        latestSession &&
        (latestSession.isError || latestSession.data?.status !== 'active')
      )
        return
      if (!latest.isError && latest.data?.slug && !latest.data.closed_at) {
        navigateTo('room', latest.data.slug)
      }
    } finally {
      if (activeSelection.current === selection.id) setJoining(false)
    }
  }

  // 切换选中项时清掉「已复制」瞬时态。
  useEffect(() => setCopied(null), [selection.id])

  const label = selection.name || t('home.untitled')
  const link = selection.slug
    ? `${window.location.origin}/${selection.slug}`
    : null

  const timeText = (() => {
    if (!selection.timeIso) return null
    try {
      return new Intl.DateTimeFormat(i18n.language || undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(selection.timeIso))
    } catch {
      return selection.timeIso
    }
  })()

  const copy = async (kind: 'id' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500)
    } catch {
      /* 剪贴板被策略拒绝:静默,用户可手动选择文本 */
    }
  }

  const handleDelete = async () => {
    if (
      !(await askConfirm({
        message: t('home.deleteConfirm', { name: label }),
        danger: true,
      }))
    ) {
      return
    }
    deleteRoom(selection.slug || selection.id, { onSuccess: onClose })
  }

  return (
    <aside
      data-testid="meeting-detail-panel"
      className={css({
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid token(colors.border.subtle)',
        backgroundColor: 'surface.default',
        color: 'text.primary',
        overflowY: 'auto',
      })}
    >
      {/* 顶部操作行(对标飞书:操作图标在右上)。三个动作都是纯图标,统一走
          IconButton —— 尺寸、悬停、焦点环、无障碍名与 Tooltip 由基元一处给出。 */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 'xs',
          paddingTop: 'md',
          paddingX: 'md',
        })}
      >
        {selection.kind === 'scheduled' && (
          <IconButton
            size="icon32"
            label={t('share.action', { defaultValue: '分享会议' })}
            onPress={() => setSharing(true)}
            data-testid="meeting-detail-share"
          >
            <RiShareForwardLine size={18} aria-hidden="true" />
          </IconButton>
        )}
        {/* 删除仅房主可见:参会者对别人的会没有删除权(后端 DELETE → is_owner)。
            与日程详情、部门/会议室树一致:静止态同为中性灰,hover 才转红。 */}
        {selection.canManage && (
          <IconButton
            size="icon32"
            variant="quaternaryDanger"
            label={t('home.delete')}
            onPress={handleDelete}
            data-testid="meeting-detail-delete"
          >
            <RiDeleteBinLine size={18} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton
          size="icon32"
          label={t('detail.close')}
          onPress={onClose}
          data-testid="meeting-detail-close"
        >
          <RiCloseLine size={18} aria-hidden="true" />
        </IconButton>
      </div>

      <div
        className={css({
          paddingTop: 'xs',
          paddingX: 'xl',
          paddingBottom: 'xl',
        })}
      >
        <h2
          className={css({
            margin: 0,
            textStyle: 'titleMedium',
            color: 'text.primary',
            wordBreak: 'break-word',
          })}
        >
          {label}
        </h2>

        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
            marginTop: 'lg',
          })}
        >
          {timeText && (
            <div className={rowCls}>
              <RiTimeLine size={16} className={rowIconCls} aria-hidden />
              {/* 图标已表意,不带「预约时间:」前缀(与 App 端对齐)。 */}
              <span className={rowTextCls}>{timeText}</span>
            </div>
          )}
          {selection.slug && (
            <div className={rowCls}>
              <RiHashtag size={16} className={rowIconCls} aria-hidden />
              {/* 会议号纯分组数字,# 图标已表意(与 App 端 formatSlug 同口径)。 */}
              <span className={rowTextCls}>
                {formatSlugDigits(selection.slug)}
              </span>
              <button
                type="button"
                onClick={() => void copy('id', selection.slug!)}
                className={linkBtnCls}
              >
                {copied === 'id' ? t('detail.copied') : t('detail.copy')}
              </button>
            </div>
          )}
          {link && (
            <div className={rowCls}>
              <RiLinkM size={16} className={rowIconCls} aria-hidden />
              <span
                className={css({
                  flex: 1,
                  minWidth: 0,
                  textStyle: 'bodySmall',
                  color: 'text.secondary',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
                title={link}
              >
                {link}
              </span>
              <button
                type="button"
                onClick={() => void copy('link', link)}
                className={linkBtnCls}
              >
                {copied === 'link' ? t('detail.copied') : t('detail.copy')}
              </button>
            </div>
          )}
        </div>

        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
            marginTop: 'xl',
          })}
        >
          {selection.slug && (
            <Button
              variant="primary"
              size="action"
              fullWidth
              icon={<RiVidiconLine size={16} aria-hidden />}
              // loading 同时置 aria-busy 并禁止重复提交,不再手搓禁用底/禁用字。
              loading={joining || meetingRoom.isLoading}
              isDisabled={!canJoin}
              onPress={() => void handleJoin()}
              data-testid="meeting-detail-enter"
            >
              {isClosed ? tRoom('ended.title') : t('home.enterMeeting')}
            </Button>
          )}
          {meetingRoom.isError && (
            <StateHint
              state="error"
              action={
                <Button
                  variant="tertiary"
                  size="sm"
                  onPress={() => {
                    void meetingRoom.refetch()
                  }}
                >
                  {t('error.retry')}
                </Button>
              }
            >
              {t('error.loadFailed')}
            </StateHint>
          )}
          {selection.kind === 'recent' && (
            <MeetingRecordLinks
              roomId={selection.id}
              sessionId={selection.sessionId}
            />
          )}
        </div>
      </div>
      {sharing && selection.kind === 'scheduled' && selection.slug && (
        <MeetingShareDialog
          meeting={{
            id: selection.id,
            slug: selection.slug,
            name: label,
            status: 'scheduled',
            scheduledAt: selection.timeIso,
          }}
          onClose={() => setSharing(false)}
        />
      )}
    </aside>
  )
}

const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
})

const rowIconCls = css({ flexShrink: 0, color: 'icon.secondary' })

/** 信息值那一列:辅助信息样式 + 占满剩余宽度(属性不重叠,可安全 cx)。 */
const rowTextCls = cx(rowMeta, css({ flex: 1, minWidth: 0 }))
