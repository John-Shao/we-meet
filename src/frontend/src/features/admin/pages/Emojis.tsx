import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiArrowUpLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button, IconButton, Input } from '@/primitives'
import { StateHint } from '@/components/StateHint'

import {
  disableAdminEmoji,
  listAdminEmojis,
  updateAdminEmoji,
  uploadAdminEmoji,
} from '../api/adminEmojis'

export const AdminEmojis = () => {
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const { t } = useTranslation('admin')
  const {
    data: emojis = [],
    isFetching,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'im-emojis'],
    queryFn: listAdminEmojis,
  })
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['admin', 'im-emojis'] })
  const upload = useMutation({
    mutationFn: ({ file, label }: { file: File; label: string }) =>
      uploadAdminEmoji(file, label),
    onSuccess: () => {
      setName('')
      void refresh()
    },
  })
  const mutate = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string
      patch?: Parameters<typeof updateAdminEmoji>[1]
    }) => {
      if (patch) await updateAdminEmoji(id, patch)
      else await disableAdminEmoji(id)
    },
    onSuccess: () => void refresh(),
  })
  const reorder = useMutation({
    mutationFn: async ({
      id,
      sortOrder,
      previousId,
      previousSortOrder,
    }: {
      id: string
      sortOrder: number
      previousId: string
      previousSortOrder: number
    }) =>
      Promise.all([
        updateAdminEmoji(id, { sort_order: previousSortOrder }),
        updateAdminEmoji(previousId, { sort_order: sortOrder }),
      ]),
    onSuccess: () => void refresh(),
  })
  const operationError = upload.error ?? mutate.error ?? reorder.error

  return (
    <main className={pageCls}>
      <header className={headerCls}>
        <h1 className={titleCls}>{t('shell.nav.emojis')}</h1>
        <p className={descriptionCls}>{t('emojis.description')}</p>
        <div className={uploadRowCls}>
          <Input
            value={name}
            maxLength={32}
            disabled={upload.isPending}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('emojis.namePlaceholder')}
            className={nameInputCls}
          />
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={!name.trim() || upload.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file && name.trim())
                upload.mutate({ file, label: name.trim() })
            }}
          />
          <Button
            size="action"
            variant="primary"
            loading={upload.isPending}
            isDisabled={!name.trim()}
            onPress={() => fileInputRef.current?.click()}
          >
            {upload.isPending ? t('emojis.uploading') : t('emojis.chooseImage')}
          </Button>
        </div>
      </header>

      <div className={contentCls}>
        {operationError ? (
          <StateHint state="error">{operationError.message}</StateHint>
        ) : null}
        {isFetching && emojis.length === 0 ? (
          <StateHint state="loading">{t('emojis.loading')}</StateHint>
        ) : isError && emojis.length === 0 ? (
          <StateHint
            state="error"
            action={
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void refetch()}
              >
                {t('feedback.retry')}
              </Button>
            }
          >
            {t('feedback.loadFailed')}
          </StateHint>
        ) : emojis.length === 0 ? (
          <StateHint>{t('emojis.empty')}</StateHint>
        ) : (
          <div className={gridCls}>
            {emojis.map((emoji, index) => (
              <article
                key={emoji.id}
                className={cardCls}
                data-disabled={!emoji.active || undefined}
              >
                <img
                  src={emoji.url}
                  alt={emoji.name}
                  className={css({
                    width: '3rem',
                    height: '3rem',
                    objectFit: 'contain',
                  })}
                />
                <div className={css({ flex: 1 })}>
                  <b>{emoji.name}</b>
                  <div
                    className={css({
                      fontSize: '0.75rem',
                      color: 'greyscale.500',
                    })}
                  >
                    {emoji.width}×{emoji.height}
                    {emoji.animated ? ' · GIF' : ''}
                  </div>
                </div>
                <IconButton
                  label={t('emojis.moveUp')}
                  size="icon28"
                  isDisabled={index === 0 || reorder.isPending}
                  onPress={() => {
                    const previous = emojis[index - 1]
                    if (!previous) return
                    reorder.mutate({
                      id: emoji.id,
                      sortOrder: emoji.sort_order,
                      previousId: previous.id,
                      previousSortOrder: previous.sort_order,
                    })
                  }}
                >
                  <RiArrowUpLine size={16} aria-hidden="true" />
                </IconButton>
                <Button
                  size="dense"
                  variant="secondary"
                  loading={
                    mutate.isPending && mutate.variables?.id === emoji.id
                  }
                  isDisabled={reorder.isPending}
                  onPress={() =>
                    mutate.mutate(
                      emoji.active
                        ? { id: emoji.id }
                        : { id: emoji.id, patch: { active: true } }
                    )
                  }
                >
                  {emoji.active ? t('emojis.disable') : t('emojis.enable')}
                </Button>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

const pageCls = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
})
const headerCls = css({
  flexShrink: 0,
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderBottom: '1px solid token(colors.border.subtle)',
})
const titleCls = css({
  margin: 0,
  color: 'text.primary',
  textStyle: 'titleMedium',
})
const descriptionCls = css({
  marginTop: 'xs',
  color: 'text.secondary',
  textStyle: 'bodySmall',
})
const uploadRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'md',
  marginTop: 'lg',
  flexWrap: 'wrap',
})
const nameInputCls = css({ width: '20rem', maxWidth: '100%' })
const contentCls = css({ flex: 1, overflowY: 'auto', padding: 'xl' })
const gridCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
  gap: 'md',
})
const cardCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'md',
  padding: 'md',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
  '&[data-disabled]': { opacity: 0.55 },
})
