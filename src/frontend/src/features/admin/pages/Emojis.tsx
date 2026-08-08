import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { css } from '@/styled-system/css'
import { disableAdminEmoji, listAdminEmojis, updateAdminEmoji, uploadAdminEmoji } from '../api/adminEmojis'

export const AdminEmojis = () => {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const { data: emojis = [], isLoading } = useQuery({ queryKey: ['admin', 'im-emojis'], queryFn: listAdminEmojis })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'im-emojis'] })
  const upload = useMutation({
    mutationFn: ({ file, label }: { file: File; label: string }) => uploadAdminEmoji(file, label),
    onSuccess: () => { setName(''); void refresh() },
  })
  const mutate = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch?: Parameters<typeof updateAdminEmoji>[1] }) => {
      if (patch) await updateAdminEmoji(id, patch)
      else await disableAdminEmoji(id)
    },
    onSuccess: () => void refresh(),
  })
  return (
    <main className={css({ flex: 1, overflow: 'auto', padding: '2rem' })}>
      <h1 className={css({ fontSize: '1.5rem', fontWeight: 'bold' })}>企业表情</h1>
      <p className={css({ color: 'greyscale.600' })}>PNG、JPG、WebP 或 GIF，最大 2 MB / 512×512；停用后历史消息仍可见。</p>
      <div className={css({ display: 'flex', gap: '0.75rem', marginY: '1.5rem' })}>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="表情名称" className={inputCls} />
        <label className={buttonCls}>{upload.isPending ? '上传中…' : '选择图片'}
          <input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={!name.trim() || upload.isPending}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file && name.trim()) upload.mutate({ file, label: name.trim() }) }} />
        </label>
      </div>
      {upload.error && <p className={css({ color: 'red.600' })}>{upload.error.message}</p>}
      {isLoading ? <p>加载中…</p> : <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))', gap: '0.75rem' })}>
        {emojis.map((emoji, index) => <article key={emoji.id} className={css({ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', border: '1px solid token(colors.greyscale.200)', borderRadius: '0.75rem', opacity: emoji.active ? 1 : 0.55 })}>
          <img src={emoji.url} alt={emoji.name} className={css({ width: '3rem', height: '3rem', objectFit: 'contain' })} />
          <div className={css({ flex: 1 })}><b>{emoji.name}</b><div className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>{emoji.width}×{emoji.height}{emoji.animated ? ' · GIF' : ''}</div></div>
          <button disabled={index === 0} onClick={() => {
            const previous = emojis[index - 1]
            if (!previous) return
            void Promise.all([
              updateAdminEmoji(emoji.id, { sort_order: previous.sort_order }),
              updateAdminEmoji(previous.id, { sort_order: emoji.sort_order }),
            ]).then(refresh)
          }}>↑</button>
          <button onClick={() => mutate.mutate(emoji.active ? { id: emoji.id } : { id: emoji.id, patch: { active: true } })}>{emoji.active ? '停用' : '启用'}</button>
        </article>)}
      </div>}
    </main>
  )
}
const inputCls = css({ border: '1px solid token(colors.greyscale.300)', borderRadius: '0.5rem', paddingX: '0.75rem' })
const buttonCls = css({ padding: '0.625rem 1rem', borderRadius: '0.5rem', backgroundColor: 'primary.500', color: 'white', cursor: 'pointer' })
