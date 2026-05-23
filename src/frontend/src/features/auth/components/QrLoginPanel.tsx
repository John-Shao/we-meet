import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { Box, Button, P } from '@/primitives'
import { Spinner } from '@/primitives/Spinner'
import { css } from '@/styled-system/css'
import { keys } from '@/api/queryKeys'
import { setTokens } from '../utils/tokenStorage'
import {
  initiateQrLogin,
  pollQrLogin,
  qrDeepLink,
  type QrLoginPollResponse,
  type QrLoginStatus,
} from '../api/qrLogin'

const POLL_INTERVAL_MS = 2000
const QR_SIZE_PX = 200

interface QrLoginPanelProps {
  /** Called once tokens are stashed and the user query has been invalidated. */
  onSuccess?: () => void
}

/**
 * Renders a QR code whose value is `we-meet://qr-login?token=<token>`. The
 * we-meet Android app intercepts the deep-link, calls
 * /api/qr-login/{scan,confirm}/ with its bearer, and on confirm the backend
 * mints a fresh token pair for THIS browser via Keycloak Token Exchange.
 *
 * The browser polls /api/qr-login/poll/ every 2s while the QR is visible.
 * State transitions drive the UI overlay (scanned → "请在 App 上确认",
 * confirmed → store tokens + invalidate user query, expired/cancelled →
 * "刷新" button to regenerate).
 */
export const QrLoginPanel = ({ onSuccess }: QrLoginPanelProps = {}) => {
  const { t } = useTranslation('global', { keyPrefix: 'qrLogin' })
  const queryClient = useQueryClient()

  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState<QrLoginStatus | 'loading'>('loading')
  const [scannedUser, setScannedUser] = useState<{
    phone: string
    name: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bump this to force regenerate (used by the retry button).
  const [generation, setGeneration] = useState(0)

  const onSuccessRef = useRef(onSuccess)
  useEffect(() => {
    onSuccessRef.current = onSuccess
  }, [onSuccess])

  // Mint a token whenever `generation` changes.
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    setScannedUser(null)
    setToken(null)
    initiateQrLogin()
      .then((resp) => {
        if (cancelled) return
        setToken(resp.token)
        setStatus('pending')
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message || t('error.initFailed'))
        setStatus('expired')
      })
    return () => {
      cancelled = true
    }
  }, [generation, t])

  // Poll while the token is alive AND we haven't reached a terminal state.
  useEffect(() => {
    if (!token) return
    if (status !== 'pending' && status !== 'scanned') return

    const id = window.setInterval(async () => {
      let data: QrLoginPollResponse
      try {
        data = await pollQrLogin(token)
      } catch {
        return // transient errors don't tear down the panel
      }
      if (data.status === 'scanned') {
        setStatus('scanned')
        if (data.user) setScannedUser(data.user)
        return
      }
      if (data.status === 'confirmed' && data.access_token) {
        window.clearInterval(id)
        setTokens({
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? null,
          phone: scannedUser?.phone ?? null,
        })
        await queryClient.invalidateQueries({ queryKey: [keys.user] })
        setStatus('confirmed')
        onSuccessRef.current?.()
        return
      }
      if (data.status === 'cancelled' || data.status === 'expired') {
        window.clearInterval(id)
        setStatus(data.status)
        return
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [token, status, scannedUser, queryClient])

  const refresh = () => setGeneration((n) => n + 1)

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.75,
        minHeight: `${QR_SIZE_PX + 80}px`,
        width: '100%',
        maxWidth: '20rem',
      })}
    >
      <Box
        size="sm"
        className={css({
          padding: '0.75rem',
          backgroundColor: 'white',
          width: 'fit-content',
          position: 'relative',
        })}
      >
        {token ? (
          <QRCodeSVG value={qrDeepLink(token)} size={QR_SIZE_PX} level="M" />
        ) : (
          <div
            className={css({
              width: `${QR_SIZE_PX}px`,
              height: `${QR_SIZE_PX}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Spinner />
          </div>
        )}
        {(status === 'scanned' ||
          status === 'expired' ||
          status === 'cancelled') && (
          <div
            className={css({
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(255,255,255,0.92)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.5,
              textAlign: 'center',
              padding: '0.5rem',
            })}
          >
            {status === 'scanned' && (
              <>
                <P last className={css({ color: 'primary.600' })}>
                  ✓ {t('scanned')}
                </P>
                {scannedUser?.phone && (
                  <P last className={css({ fontSize: 'sm' })}>
                    {scannedUser.phone}
                  </P>
                )}
                <P last className={css({ fontSize: 'sm' })}>
                  {t('awaitingConfirm')}
                </P>
              </>
            )}
            {(status === 'expired' || status === 'cancelled') && (
              <>
                <P last>
                  {status === 'expired' ? t('expired') : t('cancelled')}
                </P>
                <Button variant="primary" onPress={refresh}>
                  {t('refresh')}
                </Button>
              </>
            )}
          </div>
        )}
      </Box>

      {status === 'pending' && (
        <P last className={css({ textAlign: 'center', fontSize: 'sm' })}>
          {t('hint')}
        </P>
      )}

      {error && status !== 'expired' && (
        <P last className={css({ color: 'danger', fontSize: 'sm' })}>
          {error}
        </P>
      )}
    </div>
  )
}
