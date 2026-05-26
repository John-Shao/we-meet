import { useEffect, useMemo, useState } from 'react'

import { useTranslation } from 'react-i18next'

import { Button, Text } from '@/primitives'
import { Select } from '@/primitives/Select'
import { srOnly } from '@/styles/a11y'
import { css } from '@/styled-system/css'

import { useAIAgentConfig } from '../api/aiAgent'
import { useAIAssistant } from '../hooks/useAIAssistant'

const panelStyle = css({
  width: '320px',
  padding: '1rem',
  backgroundColor: 'white',
  borderRadius: '8px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})

const sectionLabel = css({
  fontSize: '0.875rem',
  fontWeight: 600,
  marginBottom: '0.25rem',
  display: 'block',
})

const statusRow = css({
  fontSize: '0.875rem',
  color: 'gray.700',
})

const errorText = css({
  fontSize: '0.8rem',
  color: 'red.600',
})

const PROFILE_DEFAULT_KEY = '__profile_default__'

export const AIAssistantPanel = () => {
  const { t } = useTranslation('ai-assistant')

  const { data: config, isLoading: isConfigLoading } = useAIAgentConfig()
  const {
    isActive,
    start,
    stop,
    isStarting,
    isStopping,
    startError,
    stopError,
    canControl,
  } = useAIAssistant()

  const profiles = config?.profiles ?? []
  const prompts = config?.prompts ?? []
  const userPref = config?.user_preference ?? null

  // ---- Profile selection ------------------------------------------------
  const [profileCode, setProfileCode] = useState<string>('')

  useEffect(() => {
    if (!profiles.length) return
    if (profileCode && profiles.some((p) => p.code === profileCode)) return
    const preferred = userPref?.profile_code
    const next =
      (preferred && profiles.find((p) => p.code === preferred)?.code) ||
      profiles[0].code
    setProfileCode(next)
  }, [profiles, userPref, profileCode])

  const activeProfile = useMemo(
    () => profiles.find((p) => p.code === profileCode),
    [profiles, profileCode]
  )
  const voices = activeProfile?.voices ?? []

  // ---- Voice selection --------------------------------------------------
  const [voiceId, setVoiceId] = useState<string | null>(null)

  useEffect(() => {
    if (!activeProfile) return
    // Priority: user pref (if it belongs to this profile) → profile default → first.
    const prefVoice =
      userPref?.voice_id &&
      voices.some((v) => v.id === userPref.voice_id)
        ? userPref.voice_id
        : null
    const next =
      prefVoice ||
      activeProfile.default_voice_id ||
      voices[0]?.id ||
      null
    setVoiceId(next)
  }, [activeProfile, voices, userPref])

  // ---- Prompt selection -------------------------------------------------
  // PROFILE_DEFAULT_KEY means "leave it to the backend / profile default".
  const [promptId, setPromptId] = useState<string>(PROFILE_DEFAULT_KEY)

  useEffect(() => {
    if (!activeProfile) return
    const prefPrompt =
      userPref?.prompt_id && prompts.some((p) => p.id === userPref.prompt_id)
        ? userPref.prompt_id
        : null
    setPromptId(
      prefPrompt ||
        activeProfile.default_prompt_id ||
        PROFILE_DEFAULT_KEY
    )
  }, [activeProfile, prompts, userPref])

  // ---- Actions ----------------------------------------------------------
  const onStart = async () => {
    if (!profileCode) return
    await start(profileCode, {
      voiceId,
      promptId: promptId === PROFILE_DEFAULT_KEY ? null : promptId,
    })
  }

  const onStop = async () => {
    await stop()
  }

  const isLocked = isActive || isConfigLoading

  return (
    <div className={panelStyle}>
      <Text variant="h3">{t('panel.title')}</Text>
      <Text className={statusRow}>
        {isActive ? t('panel.statusActive') : t('panel.statusInactive')}
      </Text>

      <div>
        <span className={sectionLabel}>{t('panel.provider')}</span>
        <Select
          label={<span className={srOnly}>{t('panel.provider')}</span>}
          aria-label={t('panel.provider')}
          selectedKey={profileCode}
          onSelectionChange={(key) => setProfileCode(key as string)}
          isDisabled={isLocked}
          items={profiles.map((p) => ({
            value: p.code,
            label: p.display_name,
          }))}
        />
      </div>

      <div>
        <span className={sectionLabel}>{t('panel.voice')}</span>
        <Select
          label={<span className={srOnly}>{t('panel.voice')}</span>}
          aria-label={t('panel.voice')}
          selectedKey={voiceId ?? undefined}
          onSelectionChange={(key) => setVoiceId(key as string)}
          isDisabled={isLocked || voices.length === 0}
          items={voices.map((v) => ({ value: v.id, label: v.label }))}
        />
      </div>

      {prompts.length > 0 && (
        <div>
          <span className={sectionLabel}>{t('panel.prompt')}</span>
          <Select
            label={<span className={srOnly}>{t('panel.prompt')}</span>}
            aria-label={t('panel.prompt')}
            selectedKey={promptId}
            onSelectionChange={(key) => setPromptId(key as string)}
            isDisabled={isLocked}
            items={[
              {
                value: PROFILE_DEFAULT_KEY,
                label: t('panel.promptDefault'),
              },
              ...prompts.map((p) => ({
                value: p.id,
                label: `${p.category_label} · ${p.label}`,
              })),
            ]}
          />
        </div>
      )}

      {(startError || stopError) && (
        <Text className={errorText}>
          {startError?.message || stopError?.message}
        </Text>
      )}

      {isActive ? (
        <Button
          variant="primary"
          onPress={onStop}
          isDisabled={!canControl || isStopping}
        >
          {isStopping ? t('panel.stopping') : t('panel.stop')}
        </Button>
      ) : (
        <Button
          variant="primary"
          onPress={onStart}
          isDisabled={!canControl || isStarting || !profileCode}
        >
          {isStarting ? t('panel.starting') : t('panel.start')}
        </Button>
      )}

      <Text className={css({ fontSize: '0.75rem', color: 'gray.600' })}>
        {t('panel.hint')}
      </Text>
    </div>
  )
}
