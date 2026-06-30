import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { HStack } from '@/styled-system/jsx'
import { Button, Field, P } from '@/primitives'
import { sendOtp, verifyOtp } from '../api/mobileOtp'
import { keys } from '@/api/queryKeys'
import { css } from '@/styled-system/css'

const PHONE_RE = /^1[3-9]\d{9}$/
const OTP_LENGTH = 6
const RESEND_COOLDOWN_MS = 60_000

type Step = 'phone' | 'otp'

interface PhoneLoginPanelProps {
  /** Called after the user query has been invalidated. */
  onSuccess?: () => void
  /** When present, renders a cancel button that invokes this. */
  onCancel?: () => void
}

/**
 * Inline phone-OTP login form, usable on its own (dual-pane home page) or
 * inside a Dialog (see PhoneLoginDialog). Owns the two-step state machine,
 * the 60-second resend cooldown, and the token-stash + query-invalidate
 * dance that completes the login.
 *
 * Step 1: phone input → POST /api/mobile/auth/send-otp/
 * Step 2: OTP input  → POST /api/mobile/auth/verify-otp/
 *                       → store {access,refresh}_token in localStorage
 *                       → invalidate user query so useUser refetches
 *                       → fire onSuccess
 *
 * No silent refresh — the access token's natural lifetime (Keycloak default
 * 5 min) is short. On 401 fetchApi clears the cached token and the user is
 * pushed back to this form by the regular UserAware flow.
 */
export const PhoneLoginPanel = ({
  onSuccess,
  onCancel,
}: PhoneLoginPanelProps = {}) => {
  const { t } = useTranslation('global', { keyPrefix: 'phoneLogin' })
  const queryClient = useQueryClient()

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
      onSuccess?.()
    } catch (e) {
      setError((e as Error).message || t('error.generic'))
    } finally {
      setIsPending(false)
    }
  }

  if (step === 'phone') {
    return (
      <>
        <Field
          type="text"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- focus the active step's field for fast keyboard entry
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
          {onCancel && (
            <Button variant="secondary" onPress={onCancel}>
              {t('cancel')}
            </Button>
          )}
        </HStack>
      </>
    )
  }

  return (
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
        // eslint-disable-next-line jsx-a11y/no-autofocus -- focus the active step's field for fast keyboard entry
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
  )
}
