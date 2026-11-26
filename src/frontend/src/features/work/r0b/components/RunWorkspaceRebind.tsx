import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import { useWorkBootstrap } from '../../r0a/api/queries'
import { useReadOnlyViewport } from '../../r0a/hooks/useReadOnlyViewport'
import { errorText, muted, sectionTitle } from '../../r0a/ui'
import type { WorkspaceGrantSummary } from '../../localBridgeTypes'

const controls = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: 'sm',
})

const field = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xxs',
  minWidth: '16rem',
  flex: 1,
})

const select = css({
  minHeight: '2.5rem',
  paddingX: 'sm',
  paddingY: 'xs',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  backgroundColor: 'surface.default',
  color: 'text.default',
})

const grantLabel = (grant: WorkspaceGrantSummary) =>
  `${grant.grantId.slice(0, 8)} · ${grant.rootIdentityHash.slice(7, 15)} · ${grant.artifactDir.join('/') || '(root)'}`

export const RunWorkspaceRebind = ({
  runId,
  runState,
  waitReason,
}: {
  runId: string | null | undefined
  runState?: string
  waitReason?: string | null
}) => {
  const { t } = useTranslation('work')
  const queryClient = useQueryClient()
  const bootstrapQ = useWorkBootstrap()
  const readOnly = useReadOnlyViewport()
  const bridge = window.weMeetDesktop?.work
  const enabled =
    !!bootstrapQ.data?.phases.includes('R0b') &&
    !!runId &&
    runState === 'waiting' &&
    waitReason === 'input' &&
    !readOnly &&
    !!bridge?.grantWorkspace &&
    !!bridge?.listWorkspaceGrants &&
    !!bridge.rebindRunWorkspace
  const [grants, setGrants] = useState<WorkspaceGrantSummary[]>([])
  const [oldGrantId, setOldGrantId] = useState('')
  const [newGrantId, setNewGrantId] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [grantAdded, setGrantAdded] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled || !bridge?.listWorkspaceGrants) return
    try {
      const items = await bridge.listWorkspaceGrants()
      setGrants(items)
      setOldGrantId((current) =>
        items.some((grant) => grant.grantId === current)
          ? current
          : (items[0]?.grantId ?? '')
      )
    } catch {
      setGrants([])
      setFailure(t('task.workspaceRebindFailed'))
    }
  }, [bridge, enabled, t])

  useEffect(() => {
    void refresh()
    return bridge?.onWorkspaceRebound?.(() => {
      setSuccess(false)
      void refresh()
      void queryClient.invalidateQueries({ queryKey: ['work', 'task'] })
      void queryClient.invalidateQueries({ queryKey: ['work', 'r0b'] })
    })
  }, [bridge, queryClient, refresh])

  const oldGrant = grants.find((grant) => grant.grantId === oldGrantId)
  const candidates = useMemo(
    () =>
      oldGrant
        ? grants.filter(
            (grant) =>
              grant.grantId !== oldGrant.grantId &&
              grant.rootIdentityHash === oldGrant.rootIdentityHash
          )
        : [],
    [grants, oldGrant]
  )

  useEffect(() => {
    setNewGrantId((current) =>
      candidates.some((grant) => grant.grantId === current)
        ? current
        : (candidates[0]?.grantId ?? '')
    )
  }, [candidates])

  if (!enabled) return null

  const addGrant = async () => {
    if (!bridge?.grantWorkspace || busy) return
    setBusy(true)
    setFailure(null)
    setSuccess(false)
    setGrantAdded(false)
    try {
      const grant = await bridge.grantWorkspace(
        oldGrant?.artifactDir ?? ['WeMeet成果']
      )
      if (!grant) return
      await refresh()
      setNewGrantId(grant.grantId)
      setGrantAdded(true)
    } catch {
      setFailure(t('task.workspaceRebindFailed'))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!bridge?.rebindRunWorkspace || !oldGrantId || !newGrantId || busy)
      return
    setBusy(true)
    setFailure(null)
    setSuccess(false)
    setGrantAdded(false)
    try {
      const result = await bridge.rebindRunWorkspace(
        runId!,
        oldGrantId,
        newGrantId
      )
      if (result.status !== 'accepted') throw new Error('rebind refused')
      setSuccess(true)
      void refresh()
      void queryClient.invalidateQueries({ queryKey: ['work', 'task'] })
      void queryClient.invalidateQueries({ queryKey: ['work', 'r0b'] })
    } catch {
      setFailure(t('task.workspaceRebindFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      aria-labelledby="work-run-workspace-rebind"
    >
      <h2 id="work-run-workspace-rebind" className={sectionTitle}>
        {t('task.workspaceRebind')}
      </h2>
      <p className={muted}>{t('task.workspaceRebindHint')}</p>
      <div className={controls}>
        <Button
          variant="secondary"
          size="dense"
          loading={busy}
          onPress={() => void addGrant()}
        >
          {t('task.workspaceGrantAdd')}
        </Button>
      </div>
      {grantAdded ? <p role="status">{t('task.workspaceGrantAdded')}</p> : null}
      {success ? <p role="status">{t('task.workspaceRebindSuccess')}</p> : null}
      {failure ? (
        <p className={errorText} role="alert">
          {failure}
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p className={muted}>{t('task.workspaceRebindUnavailable')}</p>
      ) : (
        <div className={controls}>
          <label className={field}>
            {t('task.workspaceRebindCurrent')}
            <select
              className={select}
              value={oldGrantId}
              onChange={(event) => setOldGrantId(event.target.value)}
              disabled={busy}
            >
              {grants.map((grant) => (
                <option key={grant.grantId} value={grant.grantId}>
                  {grantLabel(grant)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t('task.workspaceRebindNew')}
            <select
              className={select}
              value={newGrantId}
              onChange={(event) => setNewGrantId(event.target.value)}
              disabled={busy}
            >
              {candidates.map((grant) => (
                <option key={grant.grantId} value={grant.grantId}>
                  {grantLabel(grant)}
                </option>
              ))}
            </select>
          </label>
          <Button size="dense" loading={busy} onPress={() => void submit()}>
            {t('task.workspaceRebindSubmit')}
          </Button>
        </div>
      )}
    </section>
  )
}
