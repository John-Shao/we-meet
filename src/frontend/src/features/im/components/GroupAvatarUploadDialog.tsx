import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { Button } from '@/primitives'

import { removeGroupAvatar, uploadGroupAvatar } from '../api/groupAvatar'

const OUTPUT_SIZE = 600

const squareJpeg = async (file: File): Promise<Blob> => {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const value = new Image()
      value.onload = () => resolve(value)
      value.onerror = () => reject(new Error('Unable to read image'))
      value.src = objectUrl
    })
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE
    )
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    )
    if (!blob) throw new Error('Unable to prepare image')
    return blob
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

interface Props {
  cid: string
  currentUrl?: string
  onClose: () => void
  onChanged: () => void
}

export const GroupAvatarUploadDialog = ({
  cid,
  currentUrl,
  onClose,
  onChanged,
}: Props) => {
  const { t } = useTranslation('im', { keyPrefix: 'manage.avatar' })
  const fileRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState(currentUrl || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    []
  )

  const choose = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    if (!next) return
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    const url = URL.createObjectURL(next)
    previewRef.current = url
    setFile(next)
    setPreview(url)
    setError('')
    // Selecting the same file again should still fire change.
    event.target.value = ''
  }

  const save = async () => {
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      await uploadGroupAvatar(cid, await squareJpeg(file))
      onChanged()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!currentUrl || busy) return
    setBusy(true)
    setError('')
    try {
      await removeGroupAvatar(cid)
      onChanged()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={t('title')} maxWidth="360px">
      <div
        className={css({
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1rem',
        })}
      >
        <h2
          className={css({
            alignSelf: 'flex-start',
            margin: 0,
            fontSize: '1.0625rem',
            fontWeight: 'bold',
          })}
        >
          {t('title')}
        </h2>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          data-testid="group-avatar-choose"
          className={css({
            width: '13rem',
            height: '13rem',
            padding: 0,
            overflow: 'hidden',
            border: '2px dashed token(colors.greyscale.300)',
            borderRadius: '2rem',
            backgroundColor: 'greyscale.50',
            color: 'greyscale.500',
            cursor: 'pointer',
            _hover: { borderColor: 'primary.400', color: 'primary.600' },
          })}
        >
          {preview ? (
            <img
              src={preview}
              alt=""
              className={css({
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              })}
            />
          ) : (
            t('choose')
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={choose}
          className={css({ display: 'none' })}
        />
        <p
          className={css({
            margin: 0,
            fontSize: '0.8125rem',
            color: 'greyscale.500',
          })}
        >
          {t('hint')}
        </p>
        {error && (
          <p
            className={css({
              alignSelf: 'flex-start',
              margin: 0,
              color: 'danger.600',
            })}
          >
            {t('error', { message: error })}
          </p>
        )}
        <div
          className={css({
            width: '100%',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
          })}
        >
          {currentUrl && (
            <Button
              variant="secondary"
              size="action"
              onPress={remove}
              isDisabled={busy}
              data-testid="group-avatar-remove"
            >
              {t('remove')}
            </Button>
          )}
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            onPress={save}
            isDisabled={!file || busy}
            data-testid="group-avatar-save"
          >
            {busy ? t('uploading') : t('save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
