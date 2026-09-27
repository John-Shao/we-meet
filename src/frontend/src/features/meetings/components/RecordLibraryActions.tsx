import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { RiMore2Line } from '@remixicon/react'
import {
  ActionMenuItem,
  ActionMenuSurface,
  Dialog,
  IconButton,
} from '@/primitives'
import { css } from '@/styled-system/css'
import type { ApiMeetingRecord } from '../api/ApiMeetingRecord'
import { RecordRenameControl } from './RecordRenameControl'
import { LifecycleConfirmation } from './RecordTrash'

type Trigger = {
  x: number
  y: number
  target: HTMLElement
  link: HTMLAnchorElement
}

/** Both list layouts share the same permission checks and existing write flows. */
export function RecordLibraryActions({
  viewerId,
  record,
  children,
}: {
  viewerId: string
  record: ApiMeetingRecord
  children: (props: {
    handlers: Pick<HTMLAttributes<HTMLElement>, 'onContextMenu' | 'onKeyDown'>
    action: ReactNode
  }) => ReactNode
}) {
  const { t } = useTranslation('meetings')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [trigger, setTrigger] = useState<Trigger>()
  const [dialog, setDialog] = useState<'rename' | 'trash'>()
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const open = (target: HTMLElement, x?: number, y?: number) => {
    const row = target.closest('[data-record-row]')
    const link = row?.querySelector<HTMLAnchorElement>('a[href]')
    if (!link) return
    const bounds = target.getBoundingClientRect()
    setMessage('')
    setTrigger({ target, link, x: x ?? bounds.left, y: y ?? bounds.bottom })
  }
  const close = (restoreFocus = false) => {
    if (restoreFocus) trigger?.target.focus({ preventScroll: true })
    setTrigger(undefined)
  }

  useLayoutEffect(() => {
    if (!trigger || !menu.current) return
    const surface = menu.current
    const bounds = surface.getBoundingClientRect()
    surface.style.left = `${Math.max(8, Math.min(trigger.x, window.innerWidth - bounds.width - 8))}px`
    surface.style.top = `${Math.max(8, Math.min(trigger.y, window.innerHeight - bounds.height - 8))}px`
  }, [trigger, message])

  useEffect(() => {
    if (!trigger) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        setTrigger(undefined)
    }
    const dismiss = () => setTrigger(undefined)
    window.addEventListener('pointerdown', outside)
    window.addEventListener('focusin', outside)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('focusin', outside)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [trigger])

  const canRename = !!record.capabilities?.rename
  const canTrash =
    !!record.capabilities?.trash && record.lifecycle_revision !== undefined
  const finishDialog = () => {
    setDialog(undefined)
    button.current?.focus({ preventScroll: true })
  }
  return (
    <>
      {children({
        handlers: {
          onContextMenu: (event) => {
            event.preventDefault()
            const link =
              event.currentTarget.querySelector<HTMLAnchorElement>('a[href]')
            if (link) open(link, event.clientX, event.clientY)
          },
          onKeyDown: (event) => {
            if (
              event.key === 'ContextMenu' ||
              (event.shiftKey && event.key === 'F10')
            ) {
              event.preventDefault()
              open(event.target as HTMLElement)
            }
          },
        },
        action: (
          <span
            data-open={!!trigger || !!dialog}
            className={css({
              flexShrink: 0,
              '@media (hover: hover) and (pointer: fine)': {
                opacity: 0,
                pointerEvents: 'none',
                '&[data-open=true], [data-record-row]:hover &, [data-record-row]:focus-within &':
                  {
                    opacity: 1,
                    pointerEvents: 'auto',
                  },
              },
            })}
          >
            <IconButton
              ref={button}
              label={t('library.contextMenu.actions', {
                title: record.title || t('library.untitled'),
              })}
              size="icon32"
              tooltip={t('video.more')}
              aria-haspopup="menu"
              aria-expanded={!!trigger}
              onPress={() => {
                if (trigger) close(true)
                else if (button.current) open(button.current)
              }}
            >
              <RiMore2Line size={18} aria-hidden />
            </IconButton>
          </span>
        ),
      })}
      {trigger &&
        createPortal(
          <ActionMenuSurface
            key={`${trigger.x}:${trigger.y}`}
            ref={menu}
            ariaLabel={t('library.contextMenu.actions', {
              title: record.title || t('library.untitled'),
            })}
            onClose={() => close(true)}
            onKeyDown={(event) => {
              if (event.key === 'Tab') close(true)
            }}
            onContextMenu={(event) => event.preventDefault()}
            className={css({
              position: 'fixed',
              zIndex: 'modal',
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: 'calc(100vh - 16px)',
              overflowY: 'auto',
            })}
            style={{ left: trigger.x, top: trigger.y }}
          >
            <ActionMenuItem
              onClick={() => {
                trigger.link.click()
                close()
              }}
            >
              {t('library.contextMenu.open')}
            </ActionMenuItem>
            <ActionMenuItem
              onClick={() => {
                window.open(trigger.link.href, '_blank', 'noopener,noreferrer')
                close(true)
              }}
            >
              {t('library.contextMenu.openNewTab')}
            </ActionMenuItem>
            <ActionMenuItem
              onClick={() => {
                const href = trigger.link.href
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(href)
                    if (mounted.current) setMessage(t('summarySharing.copied'))
                  } catch {
                    if (mounted.current)
                      setMessage(t('summarySharing.copyError'))
                  }
                })()
              }}
            >
              {t('summarySharing.copyLink')}
            </ActionMenuItem>
            {canRename && (
              <ActionMenuItem
                onClick={() => {
                  close(true)
                  setDialog('rename')
                }}
              >
                {t('library.rename')}
              </ActionMenuItem>
            )}
            {canTrash && (
              <ActionMenuItem
                tone="danger"
                onClick={() => {
                  close(true)
                  setDialog('trash')
                }}
              >
                {t('trash.remove')}
              </ActionMenuItem>
            )}
            {message && (
              <p
                role="status"
                className={css({
                  maxWidth: '16rem',
                  padding: 'sm',
                  textStyle: 'bodySmall',
                  color: 'text.secondary',
                })}
              >
                {message}
              </p>
            )}
          </ActionMenuSurface>,
          document.body
        )}
      <Dialog
        title={t(dialog === 'trash' ? 'trash.remove' : 'library.rename')}
        isOpen={!!dialog && (dialog === 'trash' ? canTrash : canRename)}
        onOpenChange={(value) => {
          if (!value) finishDialog()
        }}
      >
        {dialog === 'rename' && canRename && (
          <RecordRenameControl
            viewerId={viewerId}
            recordId={record.id}
            title={record.title}
            initiallyOpen
            onCancel={finishDialog}
            onRenamed={finishDialog}
          />
        )}
        {dialog === 'trash' && canTrash && (
          <LifecycleConfirmation
            viewerId={viewerId}
            item={{
              id: record.id,
              title: record.title,
              deleted_at: null,
              lifecycle_revision: record.lifecycle_revision!,
            }}
            target="trashed"
            onCancel={finishDialog}
            onDone={finishDialog}
          />
        )}
      </Dialog>
    </>
  )
}
