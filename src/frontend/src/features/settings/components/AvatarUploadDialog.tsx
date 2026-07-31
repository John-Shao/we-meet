import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Modal } from '@/components/Modal'
import { keys } from '@/api/queryKeys'
import { uploadAvatar } from '@/features/auth/api/uploadAvatar'

/**
 * Avatar picker + cropper (P6-e). User picks an image, pans/zooms it inside a
 * square viewport, and we export a centered 600×600 JPEG (drawn from the same
 * crop transform) before uploading via the presigned-PUT flow. No external crop
 * dependency — the transform math is mirrored straight onto a canvas.
 */

const VIEWPORT = 300
const OUTPUT = 600
const MAX_ZOOM = 3

interface Offset {
  x: number
  y: number
}

export const AvatarUploadDialog = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation('settings', { keyPrefix: 'account.avatar' })
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ dx: number; dy: number; ox: number; oy: number } | null>(
    null
  )

  const [src, setSrc] = useState<string | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const baseScale =
    nat.w && nat.h ? Math.max(VIEWPORT / nat.w, VIEWPORT / nat.h) : 1
  const scale = baseScale * zoom

  const clamp = (o: Offset, s = scale): Offset => {
    const rw = nat.w * s
    const rh = nat.h * s
    return {
      x: Math.min(0, Math.max(VIEWPORT - rw, o.x)),
      y: Math.min(0, Math.max(VIEWPORT - rh, o.y)),
    }
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setError('')
    const url = URL.createObjectURL(f)
    const im = new Image()
    im.onload = () => {
      const bs = Math.max(VIEWPORT / im.naturalWidth, VIEWPORT / im.naturalHeight)
      const rw = im.naturalWidth * bs
      const rh = im.naturalHeight * bs
      setNat({ w: im.naturalWidth, h: im.naturalHeight })
      setZoom(1)
      setOffset({ x: (VIEWPORT - rw) / 2, y: (VIEWPORT - rh) / 2 })
      setSrc(url)
    }
    im.src = url
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!src) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { dx: e.clientX, dy: e.clientY, ox: offset.x, oy: offset.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setOffset(
      clamp({ x: d.ox + (e.clientX - d.dx), y: d.oy + (e.clientY - d.dy) })
    )
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const onZoom = (nz: number) => {
    const newScale = baseScale * nz
    setOffset((o) =>
      clamp(
        {
          x: VIEWPORT / 2 - (VIEWPORT / 2 - o.x) * (newScale / scale),
          y: VIEWPORT / 2 - (VIEWPORT / 2 - o.y) * (newScale / scale),
        },
        newScale
      )
    )
    setZoom(nz)
  }

  const save = async () => {
    if (!src || !imgRef.current || busy) return
    setBusy(true)
    setError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUTPUT
      canvas.height = OUTPUT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas')
      const sourceSize = VIEWPORT / scale
      ctx.drawImage(
        imgRef.current,
        -offset.x / scale,
        -offset.y / scale,
        sourceSize,
        sourceSize,
        0,
        0,
        OUTPUT,
        OUTPUT
      )
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/jpeg', 0.9)
      )
      if (!blob) throw new Error('canvas')
      await uploadAvatar(blob)
      await qc.invalidateQueries({ queryKey: [keys.user] })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={t('title')} maxWidth="380px">
      <div
        className={css({
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          alignItems: 'center',
        })}
      >
        <h2
          className={css({
            margin: 0,
            alignSelf: 'flex-start',
            fontSize: '1.0625rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('title')}
        </h2>

        {!src ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            data-testid="avatar-choose"
            className={css({
              width: `${VIEWPORT}px`,
              height: `${VIEWPORT}px`,
              borderRadius: '50%',
              border: '2px dashed token(colors.greyscale.300)',
              backgroundColor: 'greyscale.50',
              color: 'greyscale.500',
              fontSize: '0.9375rem',
              cursor: 'pointer',
              _hover: { borderColor: 'primary.400', color: 'primary.600' },
            })}
          >
            {t('choose')}
          </button>
        ) : (
          <>
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className={css({
                position: 'relative',
                width: `${VIEWPORT}px`,
                height: `${VIEWPORT}px`,
                borderRadius: '50%',
                overflow: 'hidden',
                cursor: 'grab',
                touchAction: 'none',
                backgroundColor: 'greyscale.100',
                _active: { cursor: 'grabbing' },
              })}
            >
              <img
                ref={imgRef}
                src={src}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  left: `${offset.x}px`,
                  top: `${offset.y}px`,
                  width: `${nat.w * scale}px`,
                  height: `${nat.h * scale}px`,
                  maxWidth: 'none',
                  userSelect: 'none',
                }}
              />
              {/* Ring overlay hinting the circular crop. */}
              <span
                className={css({
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  boxShadow: '0 0 0 2000px rgba(255,255,255,0.0)',
                  pointerEvents: 'none',
                })}
              />
            </div>

            <label
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                width: '100%',
                fontSize: '0.8125rem',
                color: 'greyscale.600',
              })}
            >
              {t('zoom')}
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(e) => onZoom(Number(e.target.value))}
                className={css({ flex: 1 })}
              />
            </label>

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={css({
                alignSelf: 'flex-start',
                border: 'none',
                background: 'transparent',
                color: 'primary.600',
                fontSize: '0.8125rem',
                cursor: 'pointer',
                padding: 0,
                _hover: { textDecoration: 'underline' },
              })}
            >
              {t('choose')}
            </button>
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onFile}
          className={css({ display: 'none' })}
        />

        {error && (
          <p
            className={css({
              alignSelf: 'flex-start',
              fontSize: '0.8125rem',
              color: 'danger.600',
              margin: 0,
            })}
          >
            {t('error', { message: error })}
          </p>
        )}

        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            width: '100%',
          })}
        >
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            onPress={save}
            isDisabled={!src || busy}
            data-testid="avatar-save"
          >
            {busy ? t('uploading') : t('save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
