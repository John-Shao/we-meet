import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import type { VoiceprintClient } from './api'
import { operationQueues, type OperationSummary } from './operations'

export function VoiceprintOperationsPanel({
  client,
}: {
  client: VoiceprintClient
}) {
  const { t, i18n } = useTranslation('voiceprint')
  const [summary, setSummary] = useState<OperationSummary>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const lifetime = useRef<AbortController>()
  const request = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setSummary(undefined)
    setError(false)
    setBusy(false)
    return () => controller.abort()
  }, [client])
  const load = async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    const current = ++request.current
    setBusy(true)
    setError(false)
    setSummary(undefined)
    try {
      const result = await client.operations(signal)
      if (!signal.aborted && current === request.current) setSummary(result)
    } catch {
      if (!signal.aborted && current === request.current) setError(true)
    } finally {
      if (!signal.aborted && current === request.current) setBusy(false)
    }
  }
  const duration = (value: number | null) =>
    value === null
      ? t('operations.noData')
      : t('operations.seconds', {
          value: value.toLocaleString(i18n.language, {
            maximumFractionDigits: 1,
          }),
        })
  return (
    <section className={panelCss} aria-label={t('operations.title')}>
      <h4>{t('operations.title')}</h4>
      <p>{t('operations.hint')}</p>
      <Button
        variant="secondaryText"
        size="dense"
        isDisabled={busy}
        onPress={() => void load()}
      >
        {t('operations.load')}
      </Button>
      {busy && <p role="status">{t('operations.loading')}</p>}
      {error && <p role="alert">{t('operations.error')}</p>}
      {summary && (
        <>
          <p>
            {t('operations.observed', {
              date: new Date(summary.observedAt).toLocaleString(i18n.language),
            })}
          </p>
          {!summary.available && <p>{t('disabled')}</p>}
          {operationQueues.map((name) => (
            <div key={name} className={queueCss}>
              <h5>{t(`operations.queues.${name}`)}</h5>
              <p>
                {t('operations.queueCounts', {
                  pending: summary.queues[name].pending,
                  failed: summary.queues[name].failed,
                  completed: summary.queues[name].completed,
                })}
              </p>
              <p>
                {t('operations.queueTimes', {
                  oldest: duration(summary.queues[name].oldest),
                  p95: duration(summary.queues[name].p95),
                })}
              </p>
            </div>
          ))}
          <p>{t('operations.outcomes', summary.outcomes)}</p>
          <p>
            {t('operations.otherCounts', {
              cleanup: summary.cleanupPending,
              paused: summary.pausedProfiles,
              rejected: summary.rejectedSuggestions,
            })}
          </p>
          <p>
            {t('operations.speech', { value: duration(summary.speechSeconds) })}
          </p>
        </>
      )}
    </section>
  )
}

const panelCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  minWidth: 0,
  overflowWrap: 'anywhere',
})
const queueCss = css({
  padding: 'sm',
  backgroundColor: 'surface.canvas',
  borderRadius: 'field',
})
