import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { ModalCloseButton } from '@/components/Modal'
import { navGlyphCls } from '@/styles/controls'

/**
 * The chrome shared by every right-hand IM settings panel: the `<aside>`, the
 * header with an optional back arrow, a scrolling body and an optional footer.
 *
 * Extracted from the byte-identical copies in GroupInfoPanel and
 * DirectSettingsPanel, and needed a third time for the bot sub-pages.
 *
 * Width is not set here — the surrounding `ResizablePanel` owns it, and it is
 * only 260–560px, which is why sub-pages stack vertically rather than putting
 * labels and inputs side by side.
 */
export const PanelFrame = ({
  title,
  onBack,
  onClose,
  footer,
  children,
}: {
  title: string
  /** Sub-pages pass this to get a ‹ in the header. Omitted on the root page. */
  onBack?: () => void
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) => {
  const { t } = useTranslation('im')
  return (
    <aside
      aria-label={title}
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        // P8-UX:宽度由外层 ResizablePanel(side=right)拖拽控制。
        width: '100%',
        height: '100%',
        backgroundColor: 'greyscale.000',
        borderLeft: '1px solid token(colors.greyscale.200)',
        overflow: 'hidden',
        animation: 'fade token(durations.normal) ease-out',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('bots.back')}
            data-testid="panel-back"
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
          {title}
        </h2>
        <ModalCloseButton onClose={onClose} label={t('manage.cancel')} />
      </div>

      <div className={css({ flex: 1, overflowY: 'auto' })}>{children}</div>

      {footer && (
        <div
          className={css({
            padding: '0.75rem 1rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          {footer}
        </div>
      )}
    </aside>
  )
}
