import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

/**
 * 会话 Pin 栏(P17,飞书式):有 Pin 时显示在聊天头部下方的一条 📌 摘要,
 * 点击展开完整列表(解除按钮在列表项上;权限由服务端裁决,越权会收到
 * system 错误帧并保持原状)。快照由服务端 JOIN 带回,无需二次拉取。
 */
export const PinnedBar = ({
  client,
  cid,
  nameOf,
  onJump,
}: {
  client: Client
  cid: string
  /** uid → 显示名(群昵称→目录名→uid),复用 ChatPane 的解析。 */
  nameOf: (uid: string) => string
  /** P3-M3 后补子项: 点击置顶条目跳转定位到消息(P1-M2 locate 同款)。 */
  onJump?: (seq: number) => void
}) => {
  const { t } = useTranslation('im')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data: pins = [] } = useQuery({
    queryKey: ['im', 'pins', cid],
    queryFn: () => client.listPins(cid),
    staleTime: 30_000,
  })

  // Pin 集合变化(自己或他人操作)→ 失效重取。
  useEffect(() => {
    const off = client.onPin((e) => {
      if (e.cid !== cid) return
      void queryClient.invalidateQueries({ queryKey: ['im', 'pins', cid] })
    })
    return off
  }, [client, cid, queryClient])

  if (pins.length === 0) return null

  const latest = pins[0]

  return (
    <div className={css({ position: 'relative' })}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="im-pinned-bar"
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          width: '100%',
          border: 'none',
          borderBottom: '1px solid token(colors.greyscale.200)',
          // 文字是会翻转的 greyscale.700,底色必须一起翻(否则深色下浅灰压浅蓝)。
          backgroundColor: 'brand.50',
          padding: '0.375rem 1rem',
          fontSize: '0.8125rem',
          color: 'greyscale.700',
          cursor: 'pointer',
          textAlign: 'left',
          _hover: { backgroundColor: 'brand.100' },
        })}
      >
        <span aria-hidden="true">📌</span>
        <span
          className={css({
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {latest.message.body || t('pins.noPreview')}
        </span>
        <span className={css({ flexShrink: 0, color: 'greyscale.500' })}>
          {t('pins.count', { count: pins.length })}
        </span>
      </button>

      {open && (
        <div
          className={css({
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            maxHeight: '18rem',
            overflowY: 'auto',
            backgroundColor: 'greyscale.000',
            border: '1px solid token(colors.greyscale.200)',
            borderTop: 'none',
            boxShadow: 'overlay',
          })}
          data-testid="im-pinned-list"
        >
          {pins.map((p) => (
            <div
              key={p.mid}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.5rem 1rem',
                borderBottom: '1px solid token(colors.greyscale.100)',
              })}
            >
              <div
                role={onJump ? 'button' : undefined}
                tabIndex={onJump ? 0 : undefined}
                onClick={
                  onJump
                    ? () => {
                        setOpen(false)
                        onJump(p.message.seq)
                      }
                    : undefined
                }
                onKeyDown={
                  onJump
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setOpen(false)
                          onJump(p.message.seq)
                        }
                      }
                    : undefined
                }
                data-testid={`im-pin-jump-${p.mid}`}
                className={css({
                  flex: 1,
                  minWidth: 0,
                  cursor: onJump ? 'pointer' : 'default',
                  borderRadius: '4px',
                  _hover: onJump ? { backgroundColor: 'greyscale.100' } : {},
                })}
              >
                <div
                  className={css({
                    fontSize: '0.75rem',
                    color: 'greyscale.500',
                  })}
                >
                  {nameOf(p.message.sender_uid)}
                </div>
                <div
                  className={css({
                    fontSize: '0.875rem',
                    color: 'greyscale.900',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  })}
                >
                  {p.message.body || t('pins.noPreview')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => client.pin(cid, p.mid, 'remove')}
                title={t('pins.unpin')}
                aria-label={t('pins.unpin')}
                data-testid={`im-unpin-${p.mid}`}
                className={css({
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
                  cursor: 'pointer',
                  color: 'greyscale.600',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
