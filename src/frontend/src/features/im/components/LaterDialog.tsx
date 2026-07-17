import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'

import { listLater, type LaterItem } from '../api/listLater'
import { doneLater } from '../api/doneLater'
import { removeLater } from '../api/removeLater'

interface Props {
  /** Jump into the item's conversation (ImRoute selects the cid + closes).
   * P1-M2: seq rides along so the pane can locate the exact message. */
  onOpenConversation: (cid: string, seq?: number) => void
  onClose: () => void
}

/** 时间戳 → 本地化短格式(同年不带年份)。 */
const fmtWhen = (iso: string, locale: string): string => {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }
  )
}

/**
 * 「稍后处理」列表(P3-M1,飞书式):跨会话的个人书签,点条目跳会话,
 * 右侧「完成 / 移除」。快照渲染 — 原消息被撤回/删除后条目仍可读。
 */
export const LaterDialog = ({ onOpenConversation, onClose }: Props) => {
  const { t, i18n } = useTranslation('im')
  const { alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['im', 'later', 'pending'],
    queryFn: () => listLater('pending'),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['im', 'later'] })
  const onError = (error: unknown) =>
    void showAlert({
      message: t('later.error', {
        message: error instanceof Error ? error.message : String(error),
      }),
    })
  const doneMutation = useMutation({
    mutationFn: (id: string) => doneLater(id),
    onSuccess: invalidate,
    onError,
  })
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeLater(id),
    onSuccess: invalidate,
    onError,
  })

  return (
    <Modal onClose={onClose} ariaLabel={t('later.title')} maxWidth="440px">
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.875rem 1rem 0.5rem',
        })}
      >
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('later.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.cancel')}
          className={css({
            border: 'none',
            background: 'none',
            fontSize: '1.25rem',
            cursor: 'pointer',
            color: 'greyscale.500',
            _hover: { color: 'greyscale.900' },
          })}
        >
          ×
        </button>
      </div>

      <div
        className={css({
          overflowY: 'auto',
          flex: 1,
          minHeight: '8rem',
          maxHeight: '60vh',
        })}
      >
        {isLoading ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('list.loading')}
          </p>
        ) : items.length === 0 ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('later.empty')}
          </p>
        ) : (
          items.map((item: LaterItem) => (
            <div
              key={item.id}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1rem',
                borderBottom: '1px solid token(colors.greyscale.100)',
                _hover: { backgroundColor: 'greyscale.50' },
              })}
              data-testid={`later-item-${item.id}`}
            >
              <button
                type="button"
                onClick={() => onOpenConversation(item.cid, item.seq)}
                className={css({
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  textAlign: 'left',
                  cursor: 'pointer',
                })}
              >
                <span
                  className={css({
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    fontSize: '0.75rem',
                    color: 'greyscale.500',
                  })}
                >
                  <span
                    className={css({
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    })}
                  >
                    {item.sender_name}
                  </span>
                  <span className={css({ flexShrink: 0 })}>
                    {fmtWhen(item.created_at, i18n.language)}
                  </span>
                </span>
                <span
                  className={css({
                    display: 'block',
                    marginTop: '0.125rem',
                    fontSize: '0.875rem',
                    color: 'greyscale.900',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  })}
                >
                  {item.snippet || t('later.noPreview')}
                </span>
              </button>
              <button
                type="button"
                onClick={() => doneMutation.mutate(item.id)}
                title={t('later.done')}
                aria-label={t('later.done')}
                data-testid={`later-done-${item.id}`}
                className={actionBtnCls}
              >
                ✓
              </button>
              <button
                type="button"
                onClick={() => removeMutation.mutate(item.id)}
                title={t('later.remove')}
                aria-label={t('later.remove')}
                data-testid={`later-remove-${item.id}`}
                className={actionBtnCls}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

const actionBtnCls = css({
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  width: '1.5rem',
  height: '1.5rem',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.75rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.900' },
})
