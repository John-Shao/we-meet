import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { Button, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'
import {
  mergeHotwords,
  validateVocabulary,
  type PersonalVocabulary as Vocabulary,
} from '../personalHotwords'

const path = 'recording-hotwords/'
const stack = css({ display: 'flex', flexDirection: 'column', gap: 'sm' })

export function PersonalHotwords(props: {
  viewerId: string
  value: string
  disabled: boolean
  onApply: (value: string) => void
}) {
  return <Editor key={props.viewerId} {...props} />
}

function Editor({
  value,
  disabled,
  onApply,
}: {
  value: string
  disabled: boolean
  onApply: (value: string) => void
}) {
  const { t } = useTranslation('meetings')
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState<Vocabulary | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const active = useRef(true)
  const working = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const read = async () => {
    if (disabled || working.current) return
    setOpen(true)
    setBusy(true)
    working.current = true
    setMessage('')
    setBase(null)
    try {
      const data = await fetchApi<Vocabulary>(path, { cache: 'no-store' })
      validateVocabulary(data)
      if (active.current) {
        setBase(data)
        setDraft(data.words.join('\n'))
      }
    } catch {
      if (active.current) {
        setDraft('')
        setMessage('error')
      }
    } finally {
      working.current = false
      if (active.current) setBusy(false)
    }
  }
  const save = async () => {
    if (!base || disabled || working.current) return
    working.current = true
    setBusy(true)
    setMessage('')
    try {
      // Use the shared bounds before sending; empty text deliberately clears the library.
      mergeHotwords(draft, [])
      const result = await fetchApi<Vocabulary>(path, {
        method: 'PUT',
        body: JSON.stringify({ text: draft, expected_revision: base.revision }),
      })
      validateVocabulary(result)
      if (active.current) {
        setBase(result)
        setDraft(result.words.join('\n'))
        setMessage('saved')
      }
    } catch (error) {
      if (!active.current) return
      const status = error instanceof ApiError ? error.statusCode : 0
      if ([401, 403, 404].includes(status)) {
        setBase(null)
        setDraft('')
      }
      setMessage(
        status === 409
          ? 'conflict'
          : status === 400 ||
              (error instanceof Error && error.message === 'hotwords_too_large')
            ? 'limit'
            : 'error'
      )
    } finally {
      working.current = false
      if (active.current) setBusy(false)
    }
  }
  if (!open)
    return (
      <Button
        type="button"
        size="dense"
        variant="secondaryText"
        isDisabled={disabled}
        onPress={() => void read()}
      >
        {t('personalHotwords.title')}
      </Button>
    )
  const locked = disabled || busy
  return (
    <section className={stack} aria-label={t('personalHotwords.title')}>
      <h3>{t('personalHotwords.title')}</h3>
      <p>{t('personalHotwords.hint')}</p>
      {base && (
        <>
          <label>
            {t('personalHotwords.editor')}
            <TextArea
              rows={5}
              maxLength={4000}
              value={draft}
              disabled={locked}
              onChange={(e) => {
                setDraft(e.target.value)
                setMessage('')
              }}
            />
          </label>
          <Button
            type="button"
            size="dense"
            variant="secondaryText"
            isDisabled={locked}
            onPress={() => {
              setDraft(value)
              setMessage('')
            }}
          >
            {t('personalHotwords.copyCurrent')}
          </Button>
          <Button
            type="button"
            size="dense"
            isDisabled={locked || draft === base.words.join('\n')}
            onPress={() => void save()}
          >
            {t('personalHotwords.save')}
          </Button>
          <Button
            type="button"
            size="dense"
            isDisabled={
              locked || !base.words.length || draft !== base.words.join('\n')
            }
            onPress={() => {
              try {
                onApply(mergeHotwords(value, base.words))
                setMessage('applied')
              } catch {
                setMessage('limit')
              }
            }}
          >
            {t('personalHotwords.apply')}
          </Button>
        </>
      )}
      {message && <p role="status">{t(`personalHotwords.${message}`)}</p>}
      <Button
        type="button"
        size="dense"
        variant="secondaryText"
        isDisabled={locked}
        onPress={() => void read()}
      >
        {t(base ? 'personalHotwords.reload' : 'library.refresh')}
      </Button>
      <Button
        type="button"
        size="dense"
        variant="secondaryText"
        isDisabled={busy}
        onPress={() => {
          setOpen(false)
          setBase(null)
          setDraft('')
          setMessage('')
        }}
      >
        {t('personalHotwords.close')}
      </Button>
    </section>
  )
}
