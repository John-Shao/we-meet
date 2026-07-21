import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiFileList3Line,
  RiHashtag,
  RiLinkM,
  RiTimeLine,
  RiVidiconLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { navigateTo } from '@/navigation/navigateTo'
import { useConfirm } from '@/components/ConfirmProvider'
import { useDeleteRoom } from '@/features/rooms/api/deleteRoom'

/** 会议列表选中项(预约 / 历史共用的展示子集)。 */
export interface MeetingSelection {
  kind: 'scheduled' | 'recent'
  id: string
  name: string
  slug: string | null
  /** scheduled → scheduled_at;recent → summary_updated_at。 */
  timeIso: string | null
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
  const { confirm: askConfirm } = useConfirm()
  const { mutate: deleteRoom } = useDeleteRoom()
  const [copied, setCopied] = useState<'id' | 'link' | null>(null)

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
        borderLeft: '1px solid token(colors.greyscale.200)',
        backgroundColor: 'greyscale.000',
        overflowY: 'auto',
      })}
    >
      {/* 顶部操作行(对标飞书:操作图标在右上)。 */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.25rem',
          padding: '0.75rem 0.75rem 0',
        })}
      >
        <button
          type="button"
          onClick={handleDelete}
          title={t('home.delete')}
          aria-label={t('home.delete')}
          data-testid="meeting-detail-delete"
          className={iconBtnCls}
        >
          <RiDeleteBinLine size={18} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('detail.close')}
          data-testid="meeting-detail-close"
          className={iconBtnCls}
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      <div className={css({ padding: '0.25rem 1.25rem 1.25rem' })}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1.0625rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
            lineHeight: 1.4,
            wordBreak: 'break-word',
          })}
        >
          {label}
        </h2>

        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.625rem',
            marginTop: '1rem',
          })}
        >
          {timeText && (
            <div className={rowCls}>
              <RiTimeLine size={16} className={rowIconCls} />
              <span className={rowTextCls}>
                {selection.kind === 'scheduled'
                  ? t('home.scheduledTimePrefix', { time: timeText })
                  : timeText}
              </span>
            </div>
          )}
          {selection.slug && (
            <div className={rowCls}>
              <RiHashtag size={16} className={rowIconCls} />
              <span className={rowTextCls}>
                {t('detail.meetingId', { id: selection.slug })}
              </span>
              <button
                type="button"
                onClick={() => void copy('id', selection.slug!)}
                className={copyBtnCls}
              >
                {copied === 'id' ? t('detail.copied') : t('detail.copy')}
              </button>
            </div>
          )}
          {link && (
            <div className={rowCls}>
              <RiLinkM size={16} className={rowIconCls} />
              <span
                className={css({
                  flex: 1,
                  minWidth: 0,
                  fontSize: '0.8125rem',
                  color: 'greyscale.600',
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
                className={copyBtnCls}
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
            gap: '0.5rem',
            marginTop: '1.25rem',
          })}
        >
          {selection.slug && (
            <button
              type="button"
              onClick={() => navigateTo('room', selection.slug as string)}
              data-testid="meeting-detail-enter"
              className={css({
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
                width: '100%',
                paddingY: '0.5625rem',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'primary.500',
                color: 'white',
                fontSize: '0.875rem',
                fontWeight: 'medium',
                cursor: 'pointer',
                _hover: { backgroundColor: 'primary.600' },
              })}
            >
              <RiVidiconLine size={17} />
              {t('home.enterMeeting')}
            </button>
          )}
          {selection.kind === 'recent' && (
            <button
              type="button"
              onClick={() => navigateTo('meetingDetail', selection.id)}
              data-testid="meeting-detail-summary"
              className={css({
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
                width: '100%',
                paddingY: '0.5625rem',
                border: '1px solid token(colors.greyscale.300)',
                borderRadius: '0.5rem',
                backgroundColor: 'greyscale.000',
                color: 'greyscale.800',
                fontSize: '0.875rem',
                cursor: 'pointer',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              <RiFileList3Line size={17} />
              {t('detail.viewSummary')}
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

const iconBtnCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2rem',
  height: '2rem',
  border: 'none',
  borderRadius: '0.5rem',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.900' },
})

const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})

const rowIconCls = css({ flexShrink: 0, color: 'greyscale.500' })

const rowTextCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.700',
})

const copyBtnCls = css({
  flexShrink: 0,
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  paddingX: '0.5rem',
  paddingY: '0.1875rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
