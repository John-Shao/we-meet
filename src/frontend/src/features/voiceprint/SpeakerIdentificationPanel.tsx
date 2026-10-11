import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/ApiError'
import { useConfig } from '@/api/useConfig'
import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import type { ApiMeetingRecord } from '@/features/meetings/api/ApiMeetingRecord'
import { refreshHumanSummaryIdentity } from '@/features/meetings/api/refreshHumanSummaryIdentity'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import {
  IdentificationClient,
  type IdentityOptions,
  type IdentityCandidates,
  type IdentityResponse,
  type IdentitySubmission,
  type IdentitySuggestion,
} from './identificationApi'
import {
  acknowledgeIdentityIntent,
  clearIdentityIntents,
  identityIntent,
  rememberIdentityIntent,
} from './identificationIntent'

type Props = {
  record: ApiMeetingRecord
  viewerId: string
  onPreview: (start: number, end: number) => Promise<boolean>
  onPreviewStop: () => void
  captureDiarizationId?: string | null
}
const column = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  minWidth: 0,
})
const row = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'sm',
  alignItems: 'center',
})
const input = css({
  color: 'text.primary',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  padding: 'xs',
  minWidth: 0,
  maxWidth: '100%',
})
const card = css({
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  padding: 'md',
  minWidth: 0,
  overflowWrap: 'anywhere',
})

export function SpeakerIdentificationPanel(props: Props) {
  const { data } = useConfig()
  const { t } = useTranslation('speakerIdentification')
  const [opened, setOpened] = useState(false)
  const [session, setSession] = useState(() => getAuthSnapshot().session)
  useEffect(() => {
    const check = () => {
      const next = getAuthSnapshot().session
      if (next !== session) {
        clearIdentityIntents()
        setOpened(false)
        setSession(next)
      }
    }
    const timer = setInterval(check, 250)
    window.addEventListener('storage', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('storage', check)
    }
  }, [session])
  const { record } = props
  if (
    !data?.speaker_identity?.matching_enabled ||
    !['upload', 'audio_recording'].includes(record.source_type) ||
    (record.source_type === 'audio_recording' && !props.captureDiarizationId) ||
    (record.source_type === 'upload' &&
      record.upload?.status !== 'succeeded') ||
    !record.capabilities.edit ||
    !record.capabilities.read_transcript ||
    !record.capabilities.play_media
  )
    return null
  return (
    <section aria-label={t('title')} className={column}>
      <div className={row}>
        <h3>{t('title')}</h3>
        <Button
          size="dense"
          variant="secondaryText"
          aria-expanded={opened}
          onPress={() => setOpened(!opened)}
        >
          {t(opened ? 'close' : 'open')}
        </Button>
      </div>
      {opened && (
        <IdentificationBody
          key={`${props.viewerId}:${record.id}:${session}:${props.captureDiarizationId ?? 'upload'}`}
          {...props}
        />
      )}
    </section>
  )
}

function IdentificationBody({
  record,
  viewerId,
  onPreview,
  onPreviewStop,
}: Props) {
  const { t } = useTranslation('speakerIdentification')
  const cache = useQueryClient()
  const scopeLabel = useId()
  const [client] = useState(() => new IdentificationClient(record.id, viewerId))
  const [options, setOptions] = useState<IdentityOptions>()
  const [people, setPeople] = useState<IdentityCandidates>()
  const [scope, setScope] = useState<string>()
  const [search, setSearch] = useState('')
  const [searchText, setSearchText] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [targets, setTargets] = useState<string[]>([])
  const [response, setResponse] = useState<IdentityResponse>()
  const [busy, setBusy] = useState(false)
  const [peopleBusy, setPeopleBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [previewError, setPreviewError] = useState(false)
  const [retry, setRetry] = useState<IdentitySubmission | undefined>(() =>
    identityIntent(client)
  )
  const revision = useRef(record.revision)
  const currentRecord = useRef(record)
  currentRecord.current = record
  const labels = useRef(new Map<string, string>())
  const scopeRef = useRef<string>()
  scopeRef.current = scope
  const requestKey = useRef<string | undefined>(retry?.request_key)
  const lifetime = useRef<AbortController>()
  const directory = useRef<AbortController>()
  const active = useRef<symbol>()
  const currentResponse = useRef(response)
  currentResponse.current = response
  const previewStop = useRef(onPreviewStop)
  previewStop.current = onPreviewStop

  const live = (signal: AbortSignal) =>
    !signal.aborted && sameAuthSession(client.auth)
  const fail = (reason: unknown) => {
    previewStop.current()
    setResponse(undefined)
    setPeople(undefined)
    setSelected({})
    const status = reason instanceof ApiError ? reason.statusCode : 0
    const remembered = identityIntent(client)
    if (status === 409 && remembered) {
      acknowledgeIdentityIntent(client, remembered.request_key)
      requestKey.current = undefined
    } else if (remembered) {
      requestKey.current = remembered.request_key
    }
    setRetry(status === 409 ? undefined : remembered)
    const unknownSubmission =
      remembered &&
      reason instanceof ApiError &&
      status === 404 &&
      typeof reason.body === 'object' &&
      reason.body !== null &&
      'code' in reason.body &&
      reason.body.code === 'voiceprint_identity_request_unavailable'
    setError(
      status === 409
        ? 'conflict'
        : [401, 403, 404].includes(status) && !unknownSubmission
          ? 'accessError'
          : 'requestError'
    )
  }
  const adopt = (value: IdentityResponse) => {
    revision.current = Math.max(revision.current, value.record_revision)
    requestKey.current = value.request?.request_key
    if (value.request)
      acknowledgeIdentityIntent(client, value.request.request_key)
    setResponse(value)
  }
  const sync = async (signal: AbortSignal) => {
    // Read the current server revision first, so this panel's own Refresh can
    // recover from a stale version without depending on a parent rerender.
    const value = await client.read(requestKey.current, signal)
    const expected = value.record_revision
    revision.current = Math.max(revision.current, expected)
    const nextOptions = await client.options(expected, 0, signal)
    if (!live(signal)) return
    if (nextOptions.record_revision !== value.record_revision) {
      revision.current = Math.max(expected, value.record_revision)
      throw new ApiError(409, {})
    }
    const previous = scopeRef.current
    let allowed =
      previous === 'personal'
        ? nextOptions.personal_allowed
        : nextOptions.scopes.results.some(
            (item) => item.id === previous && item.enabled
          )
    const selectedScope = options?.scopes.results.find(
      (item) => item.id === previous
    )
    if (
      !allowed &&
      previous &&
      previous !== 'personal' &&
      selectedScope?.enabled &&
      !nextOptions.required_organization_id
    ) {
      // A selected scope may be on a later page. Recheck it directly before
      // preserving it, rather than treating a first-page omission as removal.
      await client.candidates(previous, expected, '', 0, signal)
      if (!live(signal)) return
      nextOptions.scopes.results.push(selectedScope)
      allowed = true
    }
    // A scope change never carries the previous library's selected people.
    if (!allowed) {
      const first =
        previous === undefined
          ? (nextOptions.required_organization_id ??
            (nextOptions.personal_allowed ? 'personal' : undefined))
          : undefined
      setScope(first)
      setSelected({})
      setPeople(undefined)
      setSearch('')
      setSearchText('')
      setOffset(0)
    }
    nextOptions.targets.forEach((item) =>
      labels.current.set(item.id, item.name)
    )
    setTargets((before) =>
      options === undefined
        ? nextOptions.targets.map((item) => item.id)
        : before.filter((id) =>
            nextOptions.targets.some((item) => item.id === id)
          )
    )
    setOptions(nextOptions)
    setError(undefined)
    setRetry(undefined)
    adopt(value)
  }
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifetime.current?.signal
    if (!signal || active.current || !live(signal)) return
    const operation = Symbol('identity operation')
    active.current = operation
    directory.current?.abort()
    setBusy(true)
    try {
      await action(signal)
    } catch (reason) {
      if (live(signal)) fail(reason)
    } finally {
      if (active.current === operation) {
        active.current = undefined
        if (live(signal)) setBusy(false)
      }
    }
  }
  const refreshWorkspace = async () => {
    if (!sameAuthSession(client.auth)) return
    await Promise.all([
      refreshHumanSummaryIdentity(cache, viewerId, record.id),
      cache.invalidateQueries({ queryKey: ['meeting-records', viewerId] }),
      cache.invalidateQueries({
        queryKey: ['record-library-content', viewerId],
      }),
    ])
  }

  // The effect owns a fresh controller on each StrictMode setup. Only explicit
  // submission can start work; opening and polling cannot start/retry ASR.
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    active.current = undefined
    void run((signal) => sync(signal))
    return () => {
      controller.abort()
      directory.current?.abort()
      previewStop.current()
    }
    // State changes must not restart the panel's private lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  useEffect(() => {
    if (!options || scope === undefined || busy || error) return
    const controller = new AbortController()
    directory.current = controller
    setPeople(undefined)
    setPeopleBusy(true)
    void client
      .candidates(
        scope === 'personal' ? null : scope,
        options.record_revision,
        search,
        offset,
        controller.signal
      )
      .then((value) => {
        if (live(controller.signal)) setPeople(value)
      })
      .catch((reason: unknown) => {
        if (live(controller.signal)) fail(reason)
      })
      .finally(() => {
        if (live(controller.signal)) setPeopleBusy(false)
      })
    return () => controller.abort()
    // Only the selected directory/version drives this request; late responses
    // are fenced by this effect's abort and the immutable client login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, options?.record_revision, scope, search, offset, busy, error])
  useEffect(() => {
    const pending =
      response?.request?.processing ||
      response?.request?.jobs.some((job) => job.suggestion?.state === 'pending')
    if (!pending || error) return
    const timer = setInterval(() => {
      void run(async (signal) => {
        adopt(await client.read(requestKey.current, signal))
      })
    }, 5000)
    return () => clearInterval(timer)
    // Poll the current batch without copying stale render state or submitting work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    response?.request?.id,
    response?.request?.processing,
    response?.request?.jobs,
    error,
  ])

  const submit = (input?: IdentitySubmission) => {
    void run(async (signal) => {
      const command = input ?? {
        request_key: crypto.randomUUID(),
        expected_revision: revision.current,
        organization_id: scope === 'personal' ? null : scope!,
        user_ids: Object.keys(selected),
        speaker_ids: targets,
      }
      requestKey.current = command.request_key
      rememberIdentityIntent(client, command)
      // Keep exactly this command on an uncertain transport result. No new key
      // or automatic replay: the user may explicitly check or retry it.
      try {
        adopt(await client.submit(command, signal))
        setRetry(undefined)
        setError(undefined)
      } catch (reason) {
        if (!live(signal)) return
        fail(reason)
        if (!(reason instanceof ApiError) || reason.statusCode >= 500)
          setRetry(command)
      }
    })
  }
  const decide = (
    speakerId: string,
    suggestion: IdentitySuggestion,
    action: 'confirm_suggestion' | 'reject_suggestion'
  ) => {
    void run(async (signal) => {
      previewStop.current()
      const value = await client.decide(
        speakerId,
        suggestion.id,
        action,
        revision.current,
        signal
      )
      if (!live(signal)) return
      revision.current = value.record_revision!
      await refreshWorkspace()
      await sync(signal)
    })
  }
  const batch = response?.request
  const listen = async (start: number, end: number) => {
    const signal = lifetime.current?.signal
    if (!signal || !live(signal)) return
    setPreviewError(false)
    try {
      const ok = await onPreview(start, end)
      if (live(signal)) setPreviewError(!ok)
    } catch {
      if (live(signal)) setPreviewError(true)
    }
  }
  const writingDisabled = busy || peopleBusy || !!error || !options
  return (
    <div className={column}>
      <p>{t('intro')}</p>
      <p>{t('manualHint')}</p>
      <div className={row}>
        <Button
          size="dense"
          variant="secondaryText"
          isDisabled={busy}
          onPress={() => void run((signal) => sync(signal))}
        >
          {t('refresh')}
        </Button>
        {requestKey.current && (
          <Button
            size="dense"
            variant="secondaryText"
            isDisabled={busy || error === 'accessError'}
            onPress={() =>
              void run(async (signal) => {
                previewStop.current()
                adopt(
                  await client.cancel(
                    requestKey.current!,
                    Math.max(revision.current, currentRecord.current.revision),
                    signal
                  )
                )
                setError(undefined)
                setRetry(undefined)
              })
            }
          >
            {t('cancel')}
          </Button>
        )}
      </div>
      {busy && <p role="status">{t('loading')}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {retry && (
        <div className={column}>
          <p>{t('uncertain')}</p>
          <Button
            size="dense"
            variant="secondaryText"
            isDisabled={busy}
            onPress={() => submit(retry)}
          >
            {t('retrySame')}
          </Button>
        </div>
      )}
      {options && !error && (
        <>
          <label className={column}>
            <span id={scopeLabel}>{t('scope')}</span>
            <select
              aria-labelledby={scopeLabel}
              className={input}
              value={scope ?? ''}
              disabled={busy || !!retry}
              onChange={(event) => {
                directory.current?.abort()
                setScope(event.target.value || undefined)
                setSelected({})
                setPeople(undefined)
                setSearch('')
                setSearchText('')
                setOffset(0)
              }}
            >
              <option value="">{t('chooseScope')}</option>
              {options.personal_allowed && (
                <option value="personal">{t('personal')}</option>
              )}
              {options.scopes.results.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.enabled}>
                  {item.name}
                  {!item.enabled ? ` · ${t('scopeDisabled')}` : ''}
                </option>
              ))}
            </select>
          </label>
          {options.scopes.next_offset !== null && (
            <Button
              size="dense"
              variant="secondaryText"
              isDisabled={busy}
              onPress={() =>
                void run(async (signal) => {
                  const next = await client.options(
                    options.record_revision,
                    options.scopes.next_offset!,
                    signal
                  )
                  if (!live(signal)) return
                  setOptions({
                    ...options,
                    scopes: {
                      results: [
                        ...new Map(
                          [
                            ...options.scopes.results,
                            ...next.scopes.results,
                          ].map((item) => [item.id, item])
                        ).values(),
                      ],
                      next_offset: next.scopes.next_offset,
                    },
                  })
                })
              }
            >
              {t('moreScopes')}
            </Button>
          )}
          <fieldset className={column} disabled={writingDisabled || !!retry}>
            <legend>{t('targets')}</legend>
            {!options.targets.length && <p>{t('noTargets')}</p>}
            {options.targets.map((item) => (
              <label className={row} key={item.id}>
                <input
                  type="checkbox"
                  checked={targets.includes(item.id)}
                  onChange={(event) =>
                    setTargets((before) =>
                      event.target.checked
                        ? [...new Set([...before, item.id])]
                        : before.filter((id) => id !== item.id)
                    )
                  }
                />
                {item.name}
              </label>
            ))}
          </fieldset>
          <fieldset
            className={column}
            disabled={busy || !!retry || scope === undefined}
          >
            <legend>
              {t('candidates', { count: Object.keys(selected).length })}
            </legend>
            <p>{t('candidateHint')}</p>
            <div className={row}>
              <label className={column}>
                {t('search')}
                <input
                  className={input}
                  value={searchText}
                  maxLength={80}
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </label>
              <Button
                size="dense"
                variant="secondaryText"
                isDisabled={busy || peopleBusy || scope === undefined}
                onPress={() => {
                  setSearch(searchText.trim())
                  setOffset(0)
                }}
              >
                {t('find')}
              </Button>
            </div>
            {peopleBusy && <p role="status">{t('loadingCandidates')}</p>}
            {people?.results.map((item) => (
              <label className={row} key={item.id}>
                <input
                  type="checkbox"
                  checked={selected[item.id] !== undefined}
                  disabled={
                    peopleBusy ||
                    (Object.keys(selected).length >= 50 &&
                      selected[item.id] === undefined)
                  }
                  onChange={(event) =>
                    setSelected((before) => {
                      const next = { ...before }
                      if (event.target.checked) {
                        if (
                          Object.keys(before).length >= 50 &&
                          before[item.id] === undefined
                        )
                          return before
                        next[item.id] = item.name
                      } else delete next[item.id]
                      return next
                    })
                  }
                />
                {item.name}
              </label>
            ))}
            {people && !people.results.length && <p>{t('noCandidates')}</p>}
            <div className={row}>
              {offset > 0 && (
                <Button
                  size="dense"
                  variant="secondaryText"
                  isDisabled={peopleBusy}
                  onPress={() => setOffset(Math.max(0, offset - 25))}
                >
                  {t('previous')}
                </Button>
              )}
              {people?.next_offset !== null &&
                people?.next_offset !== undefined && (
                  <Button
                    size="dense"
                    variant="secondaryText"
                    isDisabled={peopleBusy}
                    onPress={() => setOffset(people.next_offset!)}
                  >
                    {t('moreCandidates')}
                  </Button>
                )}
            </div>
            {!!Object.keys(selected).length && (
              <div className={column}>
                <p>{t('selected')}</p>
                {Object.entries(selected).map(([id, name]) => (
                  <Button
                    key={id}
                    size="dense"
                    variant="secondaryText"
                    onPress={() =>
                      setSelected((before) => {
                        const next = { ...before }
                        delete next[id]
                        return next
                      })
                    }
                  >
                    {t('remove', { name })}
                  </Button>
                ))}
              </div>
            )}
          </fieldset>
          <Button
            size="dense"
            variant="secondary"
            isDisabled={
              writingDisabled ||
              !!retry ||
              !scope ||
              !targets.length ||
              !Object.keys(selected).length ||
              !!batch?.processing
            }
            onPress={() => submit()}
          >
            {t('submit')}
          </Button>
        </>
      )}
      {batch && !error && (
        <div className={column}>
          {batch.processing && <p role="status">{t('processing')}</p>}
          {batch.jobs.map((job) => {
            const suggestion = job.suggestion
            return (
              <div className={card} key={job.id}>
                <h4>{labels.current.get(job.speaker_id) ?? t('speaker')}</h4>
                <p>{t(`status.${job.status}`)}</p>
                {suggestion && (
                  <>
                    <p>
                      {suggestion.state === 'pending'
                        ? t(`result.${suggestion.result}`)
                        : t(`decision.${suggestion.state}`)}
                    </p>
                    {suggestion.verification_unavailable && (
                      <p>{t('verificationUnavailable')}</p>
                    )}
                    {suggestion.candidate && (
                      <p>
                        {t('suggested', { name: suggestion.candidate.name })}
                      </p>
                    )}
                    {suggestion.state === 'pending' && (
                      <>
                        <div className={row}>
                          {suggestion.query_intervals.map((interval, index) => (
                            <Button
                              key={interval.start_ms}
                              size="dense"
                              variant="secondaryText"
                              isDisabled={busy}
                              onPress={() =>
                                void listen(interval.start_ms, interval.end_ms)
                              }
                            >
                              {t('preview', { number: index + 1 })}
                            </Button>
                          ))}
                        </div>
                        <div className={row}>
                          <Button
                            size="dense"
                            variant="secondary"
                            isDisabled={busy || !suggestion.can_confirm}
                            onPress={() =>
                              decide(
                                job.speaker_id,
                                suggestion,
                                'confirm_suggestion'
                              )
                            }
                          >
                            {t('confirm')}
                          </Button>
                          <Button
                            size="dense"
                            variant="secondaryText"
                            isDisabled={busy || batch.processing}
                            onPress={() =>
                              decide(
                                job.speaker_id,
                                suggestion,
                                'reject_suggestion'
                              )
                            }
                          >
                            {t('reject')}
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      {previewError && <p role="alert">{t('previewError')}</p>}
    </div>
  )
}
