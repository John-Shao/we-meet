import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import { getAuthSnapshot } from '@/features/auth/utils/tokenStorage'
import { Button, Switch } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'
import { VoiceprintClient, permissions, type Scope } from './api'
import { VoiceprintController } from './controller'

export function VoiceprintSettingsPanel() {
  const { user, isLoggedIn, refetch } = useUser()
  const { t } = useTranslation('voiceprint')
  const [session, setSession] = useState(() => getAuthSnapshot().session)
  useEffect(() => {
    const timer = setInterval(() => setSession(getAuthSnapshot().session), 250)
    return () => clearInterval(timer)
  }, [])
  if (!isLoggedIn || !user) return <p>{t('loginRequired')}</p>
  return (
    <ScopeChooser
      key={`${user.id}:${session}`}
      ownerId={user.id}
      onReloadUser={() => void refetch()}
    />
  )
}

function ScopeChooser({
  ownerId,
  onReloadUser,
}: {
  ownerId: string
  onReloadUser: () => void
}) {
  const { t } = useTranslation('voiceprint')
  const [client] = useState(() => new VoiceprintClient(null, ownerId))
  const [scopes, setScopes] = useState<Scope[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [scope, setScope] = useState('personal')
  const [selectedSnapshot, setSelectedSnapshot] = useState<Scope>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const lifetime = useRef<AbortController>()
  const scopeRequest = useRef(0)
  const load = async (offset = 0) => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    const request = ++scopeRequest.current
    setBusy(true)
    try {
      const page = await client.scopes(offset, signal)
      if (signal.aborted || request !== scopeRequest.current) return
      setScopes((current) =>
        offset
          ? [
              ...new Map(
                [...current, ...page.results].map((row) => [row.id, row])
              ).values(),
            ]
          : page.results
      )
      setNext(page.next_offset)
      setError(false)
    } catch {
      if (!signal.aborted && request === scopeRequest.current) setError(true)
    } finally {
      if (!signal.aborted && request === scopeRequest.current) setBusy(false)
    }
  }
  useEffect(() => {
    lifetime.current = new AbortController()
    void load()
    return () => lifetime.current?.abort()
    // The client belongs to this mounted login; reload is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  const selected =
    scopes.find((row) => row.id === scope) ||
    (selectedSnapshot?.id === scope
      ? { ...selectedSnapshot, can_manage_policy: false }
      : undefined)
  const scopedClient = useMemo(
    () =>
      new VoiceprintClient(
        scope === 'personal' ? null : scope,
        client.ownerId,
        client.auth
      ),
    [scope, client]
  )
  return (
    <div className={contentCss}>
      <h3>{t('title')}</h3>
      <p>{t('intro')}</p>
      <Select
        aria-label={t('scope')}
        selectedKey={scope}
        items={[
          { value: 'personal', label: t('personal') },
          ...scopes.map((row) => ({ value: row.id, label: row.name })),
          ...(selected && !scopes.some((row) => row.id === selected.id)
            ? [{ value: selected.id, label: selected.name }]
            : []),
        ]}
        onSelectionChange={(value) => {
          setScope(String(value))
          setSelectedSnapshot(scopes.find((row) => row.id === value))
        }}
      />
      {error && <p role="alert">{t('scopeError')}</p>}
      {(next !== null || error) && (
        <Button
          variant="secondary"
          size="dense"
          isDisabled={busy}
          onPress={() => {
            if (error) onReloadUser()
            void load(error ? 0 : next!)
          }}
        >
          {t(error ? 'reload' : 'moreScopes')}
        </Button>
      )}
      <ScopePanel
        key={scope}
        client={scopedClient}
        scope={selected}
        onPolicyChanged={() => void load()}
        onReloadUser={onReloadUser}
      />
    </div>
  )
}

function ScopePanel({
  client,
  scope,
  onPolicyChanged,
  onReloadUser,
}: {
  client: VoiceprintClient
  scope?: Scope
  onPolicyChanged: () => void
  onReloadUser: () => void
}) {
  const { t } = useTranslation('voiceprint')
  const [controller, setController] = useState<VoiceprintController>()
  useEffect(() => {
    const current = new VoiceprintController(client)
    setController(current)
    return () => current.dispose()
  }, [client])
  return controller ? (
    <ScopeView
      controller={controller}
      scope={scope}
      onPolicyChanged={onPolicyChanged}
      onReloadUser={onReloadUser}
    />
  ) : (
    <p>{t('loading')}</p>
  )
}

function ScopeView({
  controller,
  scope,
  onPolicyChanged,
  onReloadUser,
}: {
  controller: VoiceprintController
  scope?: Scope
  onPolicyChanged: () => void
  onReloadUser: () => void
}) {
  const { t, i18n } = useTranslation('voiceprint')
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  )
  const fileId = useId()
  useEffect(() => {
    void controller.refresh()
    const poll = setInterval(() => void controller.refresh(), 5000)
    const tick = setInterval(() => controller.tick(), 250)
    const hide = () => {
      if (document.hidden) controller.cancelRecording()
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [controller])
  const disabled = state.busy || state.conflict || !state.settings
  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : t('never')
  const locale = i18n.language.startsWith('zh')
    ? 'zh-CN'
    : ['fr', 'de', 'nl'].includes(i18n.language.split('-')[0])
      ? i18n.language.split('-')[0]
      : 'en'
  if (state.loading) return <p role="status">{t('loading')}</p>
  return (
    <div className={contentCss}>
      {state.error && (
        <p role="alert" className={errorCss}>
          {t(`errors.${state.error}`)}
        </p>
      )}
      <Button
        variant="secondaryText"
        size="dense"
        isDisabled={state.busy}
        onPress={() => {
          if (state.error === 'unavailable') onReloadUser()
          void controller.refresh(true)
        }}
      >
        {t('reload')}
      </Button>
      {state.settings && (
        <>
          {!state.settings.available && <p role="status">{t('disabled')}</p>}
          {scope?.can_manage_policy && (
            <div className={rowCss}>
              <div>
                <h4>{t('organizationPolicy')}</h4>
                <p>{t('organizationPolicyHint')}</p>
              </div>
              <Switch
                aria-label={t('organizationPolicy')}
                isSelected={scope.policy.enabled}
                isDisabled={disabled}
                onChange={(value) =>
                  void controller
                    .policy(value, scope.policy.version)
                    .then(onPolicyChanged)
                }
              />
            </div>
          )}
          {permissions.map((permission) => (
            <div className={rowCss} key={permission}>
              <div>
                <h4>{t(`permissions.${permission}.title`)}</h4>
                <p>{t(`permissions.${permission}.hint`)}</p>
              </div>
              <Switch
                aria-label={t(`permissions.${permission}.title`)}
                isSelected={state.settings![permission]}
                isDisabled={
                  disabled ||
                  (!state.settings!.available && !state.settings![permission])
                }
                onChange={(value) => void controller.change(permission, value)}
              />
            </div>
          ))}
          <section className={cardCss}>
            <h4>{t('enrollmentTitle')}</h4>
            <p>{t('enrollmentHint')}</p>
            {!state.enrollment && (
              <Button
                variant="primary"
                size="dense"
                isDisabled={
                  disabled ||
                  !state.settings.available ||
                  !state.settings.allow_enrollment
                }
                onPress={() => void controller.begin(locale)}
              >
                {t('begin')}
              </Button>
            )}
            {state.enrollment && (
              <>
                <p>
                  {t('enrollmentProgress', {
                    count: state.enrollment.uploaded_slots.length,
                    maximum: state.enrollment.max_clips,
                  })}
                </p>
                <p>
                  {t('enrollmentExpires', {
                    time: formatDate(state.enrollment.expires_at),
                  })}
                </p>
                {controller.slot() >= 0 && (
                  <blockquote className={promptCss}>
                    {state.enrollment.challenges[controller.slot()]}
                  </blockquote>
                )}
                <p role="status">
                  {t(`recording.${state.phase}`, { seconds: state.elapsed })}
                </p>
                <div className={actionsCss}>
                  {state.phase === 'idle' ? (
                    <Button
                      variant="primary"
                      size="dense"
                      isDisabled={
                        disabled ||
                        !controller.canRecord() ||
                        !navigator.mediaDevices?.getUserMedia ||
                        typeof MediaRecorder === 'undefined' ||
                        typeof OfflineAudioContext === 'undefined'
                      }
                      onPress={() => void controller.record()}
                    >
                      {t('record')}
                    </Button>
                  ) : (
                    <>
                      {state.phase === 'recording' && (
                        <Button
                          variant="primary"
                          size="dense"
                          onPress={() => controller.finishRecording()}
                        >
                          {t('stop')}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="dense"
                        onPress={() => controller.cancelRecording()}
                      >
                        {t('cancelRecording')}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="secondaryText"
                    size="dense"
                    isDisabled={state.busy}
                    onPress={() => controller.endEnrollment()}
                  >
                    {t('endEnrollment')}
                  </Button>
                </div>
                <label htmlFor={fileId}>{t('file')}</label>
                <input
                  id={fileId}
                  type="file"
                  accept=".wav,audio/wav"
                  disabled={disabled || !controller.canRecord()}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void controller.file(file)
                  }}
                />
                <p>{t('fileHint')}</p>
              </>
            )}
            {state.clipUrl && (
              <>
                <PrivateAudio url={state.clipUrl} label={t('localAudio')} />
                <div className={actionsCss}>
                  <Button
                    variant="primary"
                    size="dense"
                    isDisabled={disabled || !controller.canUpload()}
                    onPress={() => void controller.upload()}
                  >
                    {t('upload')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="dense"
                    isDisabled={state.busy}
                    onPress={() => controller.discard()}
                  >
                    {t('discard')}
                  </Button>
                </div>
              </>
            )}
          </section>
          <section className={cardCss}>
            <h4>{t('profiles')}</h4>
            <p>
              {state.settings.display_state
                ? t('scopeState', {
                    state: t(`displayState.${state.settings.display_state}`),
                  })
                : t('statusUnavailable')}
            </p>
            {!state.settings.profiles.length && <p>{t('noProfile')}</p>}
            {state.settings.profiles.map((profile) => (
              <div key={profile.id} className={`${rowCss} ${profileLayoutCss}`}>
                <div>
                  <p>
                    {t(
                      `displayState.${profile.display_state || (profile.status === 'active' ? 'needs_update' : profile.status === 'paused' ? 'paused' : profile.status === 'deleted' ? 'deleting' : 'not_enabled')}`
                    )}
                  </p>
                  {profile.update_reasons?.map((reason) => (
                    <p key={reason}>{t(`updateReason.${reason}`)}</p>
                  ))}
                  <p>
                    {t('effectiveGroups', {
                      groups: profile.effective_device_groups?.length
                        ? t('defaultGroup')
                        : t('noEffectiveGroups'),
                    })}
                  </p>
                  <p>
                    {t('lastConfirmed', {
                      time: formatDate(profile.confirmed_at),
                    })}
                  </p>
                  <p>
                    {t('lastUpdated', {
                      time: formatDate(profile.last_updated_at),
                    })}
                  </p>
                </div>
                {profile.status !== 'deleted' && (
                  <Button
                    variant="secondary"
                    size="dense"
                    isDisabled={disabled}
                    onPress={() => controller.requestRemoval(profile.id)}
                  >
                    {t('delete')}
                  </Button>
                )}
              </div>
            ))}
            {state.deleteTarget && (
              <div role="alert" className={cardCss}>
                <p>
                  {t('deleteConfirmation', {
                    scope: scope?.name || t('personal'),
                  })}
                </p>
                <div className={actionsCss}>
                  <Button
                    variant="primary"
                    size="dense"
                    isDisabled={disabled}
                    onPress={() => void controller.remove()}
                  >
                    {t('confirmDelete')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="dense"
                    isDisabled={state.busy}
                    onPress={() => controller.requestRemoval(undefined)}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}
          </section>
          <section className={cardCss}>
            <h4>{t('samples')}</h4>
            {!state.samples.length && <p>{t('noSamples')}</p>}
            {state.samples.map((sample, index) => (
              <div key={sample.id} className={cardCss}>
                <h5>
                  {t('sampleTitle', {
                    index: index + 1,
                    seconds: sample.duration_ms / 1000,
                  })}
                </h5>
                <p>{t(`sampleStatus.${sample.status}`)}</p>
                <p>
                  {t('audioExpires', { time: formatDate(sample.expires_at) })}
                </p>
                {sample.status === 'quality_pending' && (
                  <p>{t('qualityHint')}</p>
                )}
                <div className={actionsCss}>
                  <Button
                    variant="secondary"
                    size="dense"
                    isDisabled={disabled || !sample.audio_available}
                    onPress={() => void controller.preview(sample)}
                  >
                    {t('listen')}
                  </Button>
                  {sample.audio_available &&
                    !['confirmed', 'rejected', 'deleted', 'expired'].includes(
                      sample.status
                    ) && (
                      <Button
                        variant="secondaryText"
                        size="dense"
                        isDisabled={
                          disabled || !state.settings!.allow_enrollment
                        }
                        onPress={() => void controller.decide(sample, false)}
                      >
                        {t('reject')}
                      </Button>
                    )}
                </div>
                {state.preview?.id === sample.id && (
                  <>
                    <PrivateAudio
                      url={state.preview.url}
                      label={t('sampleAudio')}
                      onEnded={() => controller.listened(sample.id)}
                    />
                    {sample.confirmable && (
                      <>
                        <Switch
                          isSelected={state.preview.selfConfirmed}
                          isDisabled={disabled}
                          onChange={(value) =>
                            controller.confirmSelf(sample.id, value)
                          }
                        >
                          {t('selfConfirmed')}
                        </Switch>
                        <p>{t('listenHint')}</p>
                        <Button
                          variant="primary"
                          size="dense"
                          isDisabled={
                            disabled ||
                            !state.preview.listened ||
                            !state.preview.selfConfirmed
                          }
                          onPress={() => void controller.decide(sample, true)}
                        >
                          {t('confirm')}
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
            {state.nextOffset !== null && (
              <Button
                variant="secondary"
                size="dense"
                isDisabled={disabled}
                onPress={() => void controller.more('samples')}
              >
                {t('more')}
              </Button>
            )}
          </section>
          {!!state.deletions.length && (
            <section className={cardCss}>
              <h4>{t('deletions')}</h4>
              {state.deletions.map((row) => (
                <p key={row.id}>
                  {t(`deletionStatus.${row.status}`)}
                  {row.finished_at && ` · ${formatDate(row.finished_at)}`}
                </p>
              ))}
              {state.deletionOffset !== null && (
                <Button
                  variant="secondary"
                  size="dense"
                  isDisabled={disabled}
                  onPress={() => void controller.more('deletions')}
                >
                  {t('more')}
                </Button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function PrivateAudio({
  url,
  label,
  onEnded,
}: {
  url: string
  label: string
  onEnded?: () => void
}) {
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const element = audio.current
    return () => {
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
  }, [url])
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- Private verification has no verified transcript; the prompt and labeled audio controls are displayed.
    <audio
      key={url}
      ref={audio}
      controls
      preload="metadata"
      src={url}
      aria-label={label}
      onEnded={onEnded}
    />
  )
}

const contentCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  color: 'text.primary',
  '& h3, & h4, & h5, & p': { margin: 0 },
  '& p': { textStyle: 'bodySmall', color: 'text.secondary' },
  '& p[role="alert"]': { color: 'danger.subtle-text' },
  '& audio': { maxWidth: '100%', width: '100%' },
  '& input': { maxWidth: '100%' },
})
const rowCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'md',
  paddingY: 'md',
  borderBottom: '1px solid token(colors.border.default)',
  '& h4': { textStyle: 'labelMedium' },
  '& p': { marginTop: 'xs' },
})
const cardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  padding: 'md',
  border: '1px solid token(colors.border.default)',
  borderRadius: 'panel',
  minWidth: 0,
})
const profileLayoutCss = css({
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  '& > div': { flex: '1 1 14rem', minWidth: 0 },
  '& > button': { flexShrink: 0, whiteSpace: 'nowrap' },
})
const actionsCss = css({
  display: 'flex',
  gap: 'sm',
  flexWrap: 'wrap',
  alignItems: 'center',
})
const promptCss = css({
  margin: 0,
  padding: 'md',
  backgroundColor: 'surface.canvas',
  color: 'text.primary',
  borderRadius: 'field',
  textStyle: 'bodyMedium',
  overflowWrap: 'anywhere',
})
const errorCss = css({ color: 'danger.subtle-text' })
