import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, H, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import type {
  ApiRecordSummaryVersion,
  RecordSourceReference,
} from '../api/ApiMeetingRecord'
import { SummaryTaskActions } from './SummaryTaskActions'
import { HumanSummaryHistory } from './HumanSummaryHistory'

type Content = ApiRecordSummaryVersion['content']
type Review = {
  id: string
  revision: number
  base_summary_id: string
  input_snapshot_id: string
  content: Content
}
type Draft = {
  expected_revision: number
  base_summary_id: string
  replace_base: boolean
  content: Content
}
const kinds = [
  'decisions',
  'chapters',
  'action_items',
  'open_questions',
] as const
const stack = css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })
const field = css({
  width: '100%',
  padding: '0.5rem',
  border: '1px solid',
  borderColor: 'greyscale.300',
  borderRadius: '4px',
  color: 'inherit',
  background: 'transparent',
})

export const HumanSummaryPanel = ({
  recordId,
  viewerId,
  versions,
  onSource,
}: {
  recordId: string
  viewerId: string
  versions: ApiRecordSummaryVersion[]
  onSource?: (snapshotId: string, ref: RecordSourceReference) => void
}) => {
  const { t } = useTranslation('meetings')
  const client = useQueryClient()
  const path = `meeting-records/${encodeURIComponent(recordId)}/human-summary/`
  const queryKey = ['human-summary', viewerId, recordId, path]
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchApi<{ current: Review | null; can_edit: boolean }>(path, { signal }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const [draft, setDraft] = useState<Draft>()
  const [intent, setIntent] = useState<Draft & { key: string }>()
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const current = query.data?.current
  const begin = (base?: ApiRecordSummaryVersion) => {
    if (draft || intent || inFlight.current) return
    const source = base ?? current
    if (!source) return
    setDraft({
      expected_revision: current?.revision ?? 0,
      base_summary_id: base?.id ?? current!.base_summary_id,
      replace_base: !!base && !!current,
      content: structuredClone(source.content),
    })
    setMessage('')
  }
  const save = async () => {
    if (!draft || inFlight.current || !query.data?.can_edit) return
    const payload = intent ?? { ...draft, key: crypto.randomUUID() }
    inFlight.current = true
    setSaving(true)
    setIntent(payload)
    setMessage('')
    try {
      const result = await fetchApi<{ current: Review }>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      client.setQueryData(queryKey, { ...query.data, current: result.current })
      setDraft(undefined)
      setIntent(undefined)
      setMessage('humanReview.saved')
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      ) {
        setIntent(undefined)
        setMessage(
          error.statusCode === 409
            ? 'humanReview.conflict'
            : 'humanReview.invalid'
        )
      } else setMessage('humanReview.uncertain')
      // Refresh authority/current revision, but never replace the user's draft.
      await query.refetch()
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  if (query.isError) return <Text>{t('humanReview.unavailable')}</Text>
  if (!query.data || (!current && !query.data.can_edit)) return null
  const content = draft?.content ?? current?.content
  const disabled = saving || !!intent || !query.data.can_edit
  const updatePoint = (
    kind: (typeof kinds)[number],
    index: number,
    value: object
  ) => {
    if (!draft || disabled) return
    setDraft({
      ...draft,
      content: {
        ...draft.content,
        [kind]: draft.content[kind].map((point, i) =>
          i === index ? { ...point, ...value } : point
        ),
      },
    })
  }
  return (
    <section className={stack} aria-label={t('humanReview.title')}>
      <H lvl={3}>
        {t('humanReview.title')}
        {current ? ` · ${current.revision}` : ''}
      </H>
      <Text variant="note">{t('humanReview.explanation')}</Text>
      {!draft && query.data.can_edit && (
        <>
          {current && (
            <Button size="sm" onPress={() => begin()}>
              {t('humanReview.edit')}
            </Button>
          )}
          {versions.length > 0 && (
            <>
              <label>
                {t('humanReview.base')}
                <select
                  className={field}
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">{t('humanReview.choose')}</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {t(`recordAi.stage.${version.stage}`)} ·{' '}
                      {new Date(version.created_at).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                isDisabled={
                  !versions.some((version) => version.id === selected)
                }
                onPress={() =>
                  begin(versions.find((version) => version.id === selected))
                }
              >
                {t(current ? 'humanReview.replace' : 'humanReview.create')}
              </Button>
            </>
          )}
        </>
      )}
      {content && (
        <>
          {draft ? (
            <label>
              {t('humanReview.overview')}
              <textarea
                className={field}
                rows={5}
                maxLength={8000}
                disabled={disabled}
                value={content.overview}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    content: { ...content, overview: event.target.value },
                  })
                }
              />
            </label>
          ) : (
            <Text>{content.overview}</Text>
          )}
          {kinds.map((kind) => (
            <section key={kind} className={stack}>
              <h4>{t(`recordAi.sections.${kind}`)}</h4>
              {content[kind].map((point, index) => (
                <div key={index} className={stack}>
                  {draft ? (
                    <>
                      <label>
                        {t(`recordAi.sections.${kind}`)} {index + 1}
                        <textarea
                          className={field}
                          rows={3}
                          maxLength={4000}
                          disabled={disabled}
                          value={point.text}
                          onChange={(event) =>
                            updatePoint(kind, index, {
                              text: event.target.value,
                            })
                          }
                        />
                      </label>
                      {'owner_text' in point && (
                        <>
                          <label>
                            {t('humanReview.owner')}
                            <input
                              className={field}
                              maxLength={200}
                              disabled={disabled}
                              value={point.owner_text}
                              onChange={(event) =>
                                updatePoint(kind, index, {
                                  owner_text: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            {t('humanReview.due')}
                            <input
                              className={field}
                              maxLength={200}
                              disabled={disabled}
                              value={point.due_text}
                              onChange={(event) =>
                                updatePoint(kind, index, {
                                  due_text: event.target.value,
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={disabled}
                        onPress={() =>
                          setDraft({
                            ...draft,
                            content: {
                              ...content,
                              [kind]: content[kind].filter(
                                (_, i) => i !== index
                              ),
                            },
                          })
                        }
                      >
                        {t('humanReview.remove')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Text>{point.text}</Text>
                      {'owner_text' in point && (
                        <Text variant="note">
                          {[point.owner_text, point.due_text]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      )}
                    </>
                  )}
                  {point.source_refs.length === 0 && (
                    <Text variant="note">{t('humanReview.uncited')}</Text>
                  )}
                  {!draft &&
                    current &&
                    onSource &&
                    point.source_refs.map((ref, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant="tertiary"
                        onPress={() => onSource(current.input_snapshot_id, ref)}
                      >
                        {t('recordAi.source')} {Math.floor(ref.start_ms / 1000)}
                        s
                      </Button>
                    ))}
                </div>
              ))}
              {draft && (
                <Button
                  size="sm"
                  variant="tertiary"
                  isDisabled={disabled || content[kind].length >= 100}
                  onPress={() =>
                    setDraft({
                      ...draft,
                      content: {
                        ...content,
                        [kind]: [
                          ...content[kind],
                          {
                            text: '',
                            source_refs: [],
                            ...(kind === 'action_items'
                              ? { owner_text: '', due_text: '' }
                              : {}),
                          },
                        ],
                      },
                    })
                  }
                >
                  {t('humanReview.add')}
                </Button>
              )}
            </section>
          ))}
        </>
      )}
      {draft && (
        <>
          <Text variant="note">{t('humanReview.draftNotice')}</Text>
          <Button
            size="sm"
            isDisabled={saving || !query.data.can_edit}
            onPress={() => void save()}
          >
            {t(intent ? 'humanReview.retry' : 'humanReview.save')}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={saving || !!intent}
            onPress={() => {
              setDraft(undefined)
              setMessage('')
            }}
          >
            {t('humanReview.cancel')}
          </Button>
        </>
      )}
      {!draft && current && current.content.action_items.length > 0 && (
        <SummaryTaskActions
          key={`${viewerId}:${recordId}:${current.id}`}
          recordId={recordId}
          viewerId={viewerId}
          reviewId={current.id}
          actions={current.content.action_items}
        />
      )}
      {!draft && current && (
        <HumanSummaryHistory
          recordId={recordId}
          viewerId={viewerId}
          currentId={current.id}
          onSource={onSource}
        />
      )}
      {message && <div role="status">{t(message)}</div>}
    </section>
  )
}
