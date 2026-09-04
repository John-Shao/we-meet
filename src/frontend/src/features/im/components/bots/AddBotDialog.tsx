import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RiArrowRightSLine, RiRobot2Line } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { Modal, ModalBody, ModalCloseButton } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import { navGlyphCls } from '@/styles/controls'

import { createGroupBot } from '../../api/groupBots'
import { BOT_CATALOG } from './botCatalog'
import { CustomBotForm } from './CustomBotForm'
import { inputCls, modalHead } from './botStyles'

/**
 * 添加机器人 — a two-page dialog (pick a kind → fill the form), matching 飞书.
 *
 * One Modal that swaps pages rather than a second Modal on top: the ‹ back and
 * the × would otherwise mean two different things in the same corner.
 */
export const AddBotDialog = ({
  cid,
  onClose,
  onCreated,
}: {
  cid: string
  onClose: () => void
  /** Created → jump straight to its detail page, where the webhook URL lives. */
  onCreated: (botId: string) => void
}) => {
  const { t } = useTranslation('im')
  const qc = useQueryClient()
  const { alert: showAlert } = useConfirm()
  const [page, setPage] = useState<'catalog' | 'custom'>('catalog')
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // 从「自定义」页按 ‹ 返回目录页时把焦点还给搜索框。Modal 的 initialFocusRef 只在
  // 挂载那一次生效(这是同一个 Modal 换页,不是新开弹窗),而自定义页的表单整段卸载
  // 后焦点会掉到 <body> —— 键盘用户下一次 Tab 得从对话框头部重来。
  // 刻意不用 useInlineEditFocus:page 是二值联合而非布尔,且它的"退出"分支会与
  // CustomBotForm 自己的挂载聚焦(见那边注释)抢焦点。
  useEffect(() => {
    if (page === 'catalog') searchRef.current?.focus()
  }, [page])

  const create = useMutation({
    mutationFn: createGroupBot,
    onSuccess: (bot) => {
      void qc.invalidateQueries({ queryKey: ['im', 'bots', cid] })
      // The bot's own uid becomes a message sender, and the name cache is keyed
      // per-conversation as well as globally — invalidate both prefixes.
      void qc.invalidateQueries({ queryKey: ['im', 'member-names'] })
      void qc.invalidateQueries({ queryKey: ['im', 'member-names-extra'] })
      onCreated(bot.id)
      onClose()
    },
    onError: (e: unknown) =>
      void showAlert({
        message: t('bots.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      }),
  })

  const entries = BOT_CATALOG.filter((entry) =>
    t(entry.nameKey).toLowerCase().includes(search.trim().toLowerCase())
  )

  return (
    <Modal
      onClose={onClose}
      maxWidth="640px"
      maxHeight="76vh"
      initialFocusRef={searchRef}
      ariaLabel={t(page === 'catalog' ? 'bots.addTitle' : 'bots.form.title')}
    >
      <div className={modalHead}>
        {page === 'custom' && (
          <button
            type="button"
            onClick={() => setPage('catalog')}
            aria-label={t('bots.back')}
            className={cx(
              navGlyphCls,
              css({
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: 'greyscale.600',
                padding: 0,
              })
            )}
          >
            ‹
          </button>
        )}
        <h2
          className={css({
            flex: 1,
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t(page === 'catalog' ? 'bots.addTitle' : 'bots.form.title')}
        </h2>
        <ModalCloseButton onClose={onClose} label={t('manage.cancel')} />
      </div>

      {page === 'catalog' ? (
        <ModalBody>
          <input
            ref={searchRef}
            value={search}
            placeholder={t('bots.catalog.search')}
            onChange={(e) => setSearch(e.target.value)}
            className={cx(inputCls, css({ marginBottom: '1rem' }))}
          />
          <div
            className={css({
              display: 'grid',
              // auto-fill, not auto-fit: with one entry, auto-fit would stretch
              // it across the whole row and it would read as a list, not a grid.
              gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
              gap: '0.75rem',
            })}
          >
            {entries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setPage('custom')}
                data-testid={`bot-catalog-${entry.key}`}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.625rem',
                  padding: '0.75rem',
                  border: '1px solid token(colors.greyscale.200)',
                  borderRadius: '0.5rem',
                  backgroundColor: 'greyscale.000',
                  textAlign: 'left',
                  cursor: 'pointer',
                  _hover: { backgroundColor: 'greyscale.50' },
                })}
              >
                <RiRobot2Line
                  size={28}
                  className={css({ flexShrink: 0, color: 'primary.500' })}
                />
                <span className={css({ flex: 1, minWidth: 0 })}>
                  <span
                    className={css({
                      display: 'block',
                      fontSize: '0.875rem',
                      color: 'greyscale.900',
                    })}
                  >
                    {t(entry.nameKey)}
                  </span>
                  <span
                    className={css({
                      display: 'block',
                      fontSize: '0.75rem',
                      color: 'greyscale.500',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    })}
                  >
                    {t(entry.descKey)}
                  </span>
                </span>
                <RiArrowRightSLine
                  size={16}
                  className={css({ flexShrink: 0, color: 'greyscale.500' })}
                />
              </button>
            ))}
          </div>
        </ModalBody>
      ) : (
        <CustomBotForm
          busy={create.isPending}
          submitLabel={t('bots.form.submit')}
          onCancel={() => setPage('catalog')}
          onSubmit={(value) =>
            create.mutate({
              cid,
              name: value.name,
              description: value.description,
              avatar_color_index: value.avatarColorIndex,
            })
          }
        />
      )}
    </Modal>
  )
}
