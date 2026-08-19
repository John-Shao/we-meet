import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useParams } from 'wouter'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import { css } from '@/styled-system/css'

import { previewShareToken, subscribeShareToken } from '../api/calendars'

export const CalendarSubscribeRoute = () => (
  <RequireAuth>
    <Screen>
      <SubscribeCard />
    </Screen>
  </RequireAuth>
)

const SubscribeCard = () => {
  const { token = '' } = useParams<{ token: string }>()
  const [, navigate] = useLocation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data, error: loadError } = useQuery({
    queryKey: ['calendar', 'share-preview', token],
    queryFn: () => previewShareToken(token),
    retry: false,
  })
  return (
    <main className={pageCls}>
      <section className={cardCls}>
        <h1>订阅日历</h1>
        {data ? (
          <>
            <h2>{data.display_name}</h2>
            <p>{data.description || '暂无描述'}</p>
            <p className={mutedCls}>
              所有者：{data.owner?.full_name || data.owner?.short_name || '—'} ·{' '}
              {data.subscriber_count} 人已订阅
            </p>
            <button
              type="button"
              className={buttonCls}
              disabled={busy || data.subscribed}
              onClick={() => {
                setBusy(true)
                void subscribeShareToken(token)
                  .then(() => navigate('/calendar'))
                  .catch((reason) => setError(apiErrorMessage(reason)))
                  .finally(() => setBusy(false))
              }}
            >
              {data.subscribed ? '已订阅' : '确认订阅'}
            </button>
          </>
        ) : (
          <p>{loadError ? apiErrorMessage(loadError) : '正在加载…'}</p>
        )}
        {error && <p className={errorCls}>{error}</p>}
      </section>
    </main>
  )
}

const pageCls = css({
  width: '100%',
  minHeight: '100%',
  display: 'grid',
  placeItems: 'center',
  padding: '2rem',
})
const cardCls = css({
  width: '100%',
  maxWidth: '32rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.75rem',
  background: 'greyscale.000',
  padding: '1.5rem',
  boxShadow: 'sm',
})
const mutedCls = css({ color: 'greyscale.500' })
const buttonCls = css({
  border: 0,
  borderRadius: '0.4rem',
  padding: '0.65rem 1rem',
  background: 'primary.500',
  color: 'white',
  cursor: 'pointer',
  _disabled: { opacity: 0.5 },
})
const errorCls = css({ color: '#dc2626' })
