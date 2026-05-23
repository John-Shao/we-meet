import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { HStack } from '@/styled-system/jsx'
import { Button, Dialog, Field, P, useCloseDialog } from '@/primitives'
import { sendOtp, verifyOtp } from '../api/mobileOtp'
import { keys } from '@/api/queryKeys'
import { css } from '@/styled-system/css'

const PHONE_RE = /^1[3-9]\d{9}$/
const OTP_LENGTH = 6
const RESEND_COOLDOWN_MS = 60_000

type Step = 'phone' | 'otp'

/**
 * SMS OTP login modal for web — mirror of the Android verify-otp flow.
 *
 * Step 1: phone input → POST /api/mobile/auth/send-otp/
 * Step 2: OTP input  → POST /api/mobile/auth/verify-otp/
 *                       → store {access,refresh}_token in localStorage
 *                       → invalidate user query so useUser refetches
 *                       → close dialog
 *
 * The backend's OIDCAuthentication then accepts our Authorization: Bearer
 * header on every /api/v1.0/* call (see fetchApi.ts), so once the dialog
 * closes the rest of the app sees a logged-in user with no further changes.
 *
 * No silent refresh — the access token's natural lifetime (Keycloak default
 * 5 min) is short. On 401 fetchApi clears the cached token and the user is
 * pushed back to this dialog by the regular UserAware flow.
 */
export const PhoneLoginDialog = () => {
  const { t } = useTranslation('global', { keyPrefix: 'phoneLogin' })
  const queryClient = useQueryClient()
  const close = useCloseDialog()

  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [resendAt, setResendAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())

  // 1Hz tick to drive the resend countdown.
  useEffect(() => {
    if (step !== 'otp') return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [step])

  const phoneValid = PHONE_RE.test(phone)
  const otpValid = otp.length === OTP_LENGTH && /^\d+$/.test(otp)
  const remainingSec = resendAt
    ? Math.max(0, Math.ceil((resendAt - now) / 1000))
    : 0

  const doSendOtp = async () => {
    if (!phoneValid || isPending) return
    setError(null)
    setIsPending(true)
    try {
      await sendOtp(phone)
      setStep('otp')
      setOtp('')
      setResendAt(Date.now() + RESEND_COOLDOWN_MS)
    } catch (e) {
      setError((e as Error).message || t('error.generic'))
    } finally {
      setIsPending(false)
    }
  }

  const doResend = async () => {
    if (remainingSec > 0 || isPending) return
    setError(null)
    setIsPending(true)
    try {
      await sendOtp(phone)
      setResendAt(Date.now() + RESEND_COOLDOWN_MS)
    } catch (e) {
      setError((e as Error).message || t('error.generic'))
    } finally {
      setIsPending(false)
    }
  }

  const doVerifyOtp = async () => {
    if (!otpValid || isPending) return
    setError(null)
    setIsPending(true)
    try {
      await verifyOtp(phone, otp)
      await queryClient.invalidateQueries({ queryKey: [keys.user] })
      close?.()
    } catch (e) {
      setError((e as Error).message || t('error.generic'))
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Dialog title={t('title')}>
      {step === 'phone' ? (
        <>
          <Field
            type="text"
            autoFocus
            isRequired
            name="phone"
            label={t('phoneLabel')}
            value={phone}
            onChange={(v) => {
              // Keep only digits, cap at 11 (Chinese mobile length).
              setPhone(v.replace(/\D/g, '').slice(0, 11))
              setError(null)
            }}
            inputMode="numeric"
            autoComplete="tel"
            description={t('phoneHint')}
          />
          {error && (
            <P last className={css({ color: 'danger' })}>
              {error}
            </P>
          )}
          <HStack gap="gutter">
            <Button
              variant="primary"
              onPress={doSendOtp}
              isDisabled={!phoneValid || isPending}
              loading={isPending}
            >
              {t('sendCode')}
            </Button>
            <Button variant="secondary" onPress={() => close?.()}>
              {t('cancel')}
            </Button>
          </HStack>
        </>
      ) : (
        <>
          <P>
            {t('otpSentTo')} <strong>{phone}</strong>
            {' · '}
            <button
              type="button"
              onClick={() => {
                setStep('phone')
                setOtp('')
                setError(null)
                setResendAt(null)
              }}
              className={css({
                color: 'primary.600',
                textDecoration: 'underline',
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
              })}
            >
              {t('changePhone')}
            </button>
          </P>
          <Field
            type="text"
            autoFocus
            isRequired
            name="otp"
            label={t('otpLabel')}
            value={otp}
            onChange={(v) => {
              setOtp(v.replace(/\D/g, '').slice(0, OTP_LENGTH))
              setError(null)
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          {error && (
            <P last className={css({ color: 'danger' })}>
              {error}
            </P>
          )}
          <HStack gap="gutter">
            <Button
              variant="primary"
              onPress={doVerifyOtp}
              isDisabled={!otpValid || isPending}
              loading={isPending}
            >
              {t('verify')}
            </Button>
            <Button
              variant="secondary"
              onPress={doResend}
              isDisabled={remainingSec > 0 || isPending}
            >
              {remainingSec > 0
                ? t('resendIn', { seconds: remainingSec })
                : t('resend')}
            </Button>
          </HStack>
        </>
      )}
    </Dialog>
  )
}
