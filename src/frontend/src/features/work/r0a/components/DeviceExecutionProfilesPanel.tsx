import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import { useActiveExecutionProfile, useModelProbe } from '../api/queries'
import { RunPendingApprovals } from '../../r0b/components/RunPendingApprovals'
import { card, errorText, muted, sectionTitle } from '../ui'

const field = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  maxWidth: '24rem',
})

const input = css({
  minHeight: '2.5rem',
  paddingX: 'sm',
  paddingY: 'xs',
  border: '1px solid',
  borderColor: 'border.default',
  borderRadius: 'medium',
  background: 'surface.default',
  color: 'text.default',
})

export const DeviceExecutionProfilesPanel = ({
  profileId,
}: {
  profileId: string
}) => {
  const { t } = useTranslation('work')
  const profileQ = useActiveExecutionProfile(profileId)
  const [port, setPort] = useState('')
  const [binding, setBinding] = useState<{
    bindingId: string
    status: string
    probePreview: { probeId: string }
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [submittingProbe, setSubmittingProbe] = useState(false)
  const [probeTaskId, setProbeTaskId] = useState<string>()
  const [failure, setFailure] = useState(false)
  const probeQ = useModelProbe(binding?.probePreview.probeId)
  const bindingStatus =
    probeQ.data?.state === 'verified' ? 'verified' : binding?.status

  if (profileQ.isPending) {
    return (
      <section className={card}>
        <p className={muted}>{t('loading')}</p>
      </section>
    )
  }
  if (profileQ.isError || !profileQ.data) {
    return (
      <section className={card}>
        <h2 className={sectionTitle}>{t('deviceExecution.title')}</h2>
        <p className={errorText} role="alert">
          {t('deviceExecution.loadFailed')}
        </p>
        <Button
          variant="secondary"
          size="dense"
          onPress={() => profileQ.refetch()}
        >
          {t('retry')}
        </Button>
      </section>
    )
  }

  const profile = profileQ.data
  const selectedPort = port || String(profile.allowedPorts[0] ?? '')
  const configure = async () => {
    const work = window.weMeetDesktop?.work
    if (!work || saving) return
    setSaving(true)
    setFailure(false)
    try {
      const sessionId = await work.getCurrentSessionId()
      const next = await work.createDeviceModelBinding(
        profile.profileId,
        Number(selectedPort),
        sessionId
      )
      setBinding(next)
    } catch {
      setFailure(true)
    } finally {
      setSaving(false)
    }
  }

  const runProbe = async () => {
    const work = window.weMeetDesktop?.work
    if (!work || !binding || submittingProbe) return
    setSubmittingProbe(true)
    setFailure(false)
    try {
      const submission = await work.submitConfigurationProbe(binding.bindingId)
      setProbeTaskId(submission.taskId)
    } catch {
      setFailure(true)
    } finally {
      setSubmittingProbe(false)
    }
  }

  return (
    <section className={card}>
      <h2 className={sectionTitle}>{t('deviceExecution.title')}</h2>
      <p className={muted}>{t('deviceExecution.description')}</p>
      <p className={muted}>
        {t('deviceExecution.profile', {
          model: profile.model,
          revision: profile.revision,
        })}
      </p>
      <label className={field}>
        <span>{t('deviceExecution.port')}</span>
        <input
          className={input}
          inputMode="numeric"
          value={selectedPort}
          onChange={(event) => setPort(event.target.value)}
        />
      </label>
      <Button
        variant="secondary"
        size="dense"
        loading={saving}
        onPress={configure}
      >
        {t('deviceExecution.configure')}
      </Button>
      {failure ? (
        <p className={errorText} role="alert">
          {t('deviceExecution.failed')}
        </p>
      ) : null}
      {binding ? (
        <div>
          <p role="status">
            {t('deviceExecution.binding', { status: bindingStatus })}
            {probeQ.data
              ? ` · ${t(`deviceExecution.probe.${probeQ.data.state}`)}`
              : ''}
          </p>
          {!probeTaskId ? (
            <Button
              variant="secondary"
              size="dense"
              loading={submittingProbe}
              onPress={runProbe}
            >
              {t('deviceExecution.runProbe')}
            </Button>
          ) : null}
          {probeTaskId ? (
            <>
              <p className={muted}>{t('deviceExecution.probeApprovalHint')}</p>
              <RunPendingApprovals taskId={probeTaskId} />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
