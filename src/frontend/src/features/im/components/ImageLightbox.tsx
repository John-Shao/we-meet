import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiDownloadLine,
  RiZoomInLine,
  RiZoomOutLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'

interface Props {
  /** All resolved image URLs in the conversation, in display order. */
  images: string[]
  /** Index of the image to show; null → closed. */
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
}

/**
 * 图片大图预览(飞书/微信式):居中大图、左右切换、点击/按钮缩放、下载、
 * Esc 关闭、←/→ 翻页。全屏遮罩,不复用 Modal(需铺满而非卡片)。
 */
export const ImageLightbox = ({
  images,
  index,
  onIndexChange,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const [zoomed, setZoomed] = useState(false)

  const has = index !== null && index >= 0 && index < images.length
  const canPrev = has && index > 0
  const canNext = has && index < images.length - 1

  const go = useCallback(
    (delta: number) => {
      if (index === null) return
      const next = index + delta
      if (next < 0 || next >= images.length) return
      setZoomed(false)
      onIndexChange(next)
    },
    [index, images.length, onIndexChange]
  )

  // 切换图片时重置缩放。
  useEffect(() => {
    setZoomed(false)
  }, [index])

  useEffect(() => {
    if (!has) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [has, go, onClose])

  if (!has) return null
  const url = images[index]

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
      })}
      data-testid="im-image-lightbox"
    >
      {/* top bar: counter + actions */}
      <div
        className={css({
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.25rem',
          color: 'white',
          zIndex: 1,
        })}
      >
        <span className={css({ fontSize: '0.875rem', opacity: 0.85 })}>
          {index + 1} / {images.length}
        </span>
        <div className={css({ display: 'flex', gap: '0.5rem' })}>
          <button
            type="button"
            onClick={() => setZoomed((v) => !v)}
            aria-label={t(zoomed ? 'image.zoomOut' : 'image.zoomIn')}
            title={t(zoomed ? 'image.zoomOut' : 'image.zoomIn')}
            className={iconBtn}
          >
            {zoomed ? <RiZoomOutLine size={20} /> : <RiZoomInLine size={20} />}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            download
            aria-label={t('image.download')}
            title={t('image.download')}
            className={iconBtn}
          >
            <RiDownloadLine size={20} />
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('image.close')}
            title={t('image.close')}
            className={iconBtn}
          >
            <RiCloseLine size={22} />
          </button>
        </div>
      </div>

      {canPrev && (
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label={t('image.prev')}
          className={navBtn}
          style={{ left: '1rem' }}
        >
          <RiArrowLeftSLine size={28} />
        </button>
      )}

      <div
        className={css({
          maxWidth: '92vw',
          maxHeight: '88vh',
          overflow: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        })}
      >
        <button
          type="button"
          onClick={() => setZoomed((v) => !v)}
          aria-label={t(zoomed ? 'image.zoomOut' : 'image.zoomIn')}
          className={css({
            display: 'flex',
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: zoomed ? 'zoom-out' : 'zoom-in',
          })}
        >
          <img
            src={url}
            alt={t('image.alt')}
            className={css({
              display: 'block',
              objectFit: 'contain',
              transition: 'transform 0.15s ease',
            })}
            style={
              zoomed
                ? { maxWidth: 'none', maxHeight: 'none', width: '160vw' }
                : { maxWidth: '92vw', maxHeight: '88vh' }
            }
          />
        </button>
      </div>

      {canNext && (
        <button
          type="button"
          onClick={() => go(1)}
          aria-label={t('image.next')}
          className={navBtn}
          style={{ right: '1rem' }}
        >
          <RiArrowRightSLine size={28} />
        </button>
      )}
    </div>
  )
}

const iconBtn = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2.25rem',
  height: '2.25rem',
  borderRadius: '999px',
  border: 'none',
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  cursor: 'pointer',
  textDecoration: 'none',
  _hover: { background: 'rgba(255,255,255,0.25)' },
})

const navBtn = css({
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2.75rem',
  height: '2.75rem',
  borderRadius: '999px',
  border: 'none',
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  cursor: 'pointer',
  zIndex: 1,
  _hover: { background: 'rgba(255,255,255,0.25)' },
})
