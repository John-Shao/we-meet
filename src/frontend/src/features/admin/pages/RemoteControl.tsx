import { Suspense, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { useConfirm } from '@/components/ConfirmProvider'
import { StateHint } from '@/components/StateHint'
import { DirectoryMultiPicker } from '@/features/contacts/components/DirectoryMultiPicker'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

import { useAdminMe } from '../hooks/useAdminMe'
import {
  closeRemoteControl,
  fetchRemoteControlMembers,
  fetchRemoteControlPolicy,
  saveRemoteControlPolicy,
  type RemoteControlPolicy,
  type RemoteControlPolicyView,
} from '../api/adminRemoteControl'

export const AdminRemoteControl = () => {
  const { t } = useTranslation('admin')
  const { data: me, isPending: loadingMe } = useAdminMe()
  const organizationId = me?.organization?.id
  const query = useQuery({
    queryKey: ['admin', 'remote-control-policy', organizationId],
    queryFn: fetchRemoteControlPolicy,
    enabled: !!organizationId && me?.is_org_admin === true,
    refetchOnWindowFocus: false,
  })
  if (loadingMe)
    return <StateHint state="loading">{t('remoteControl.loading')}</StateHint>
  if (!me?.is_org_admin)
    return <StateHint state="error">{t('forbidden.description')}</StateHint>
  if (query.isError)
    return (
      <StateHint
        state="error"
        action={
          <Button variant="secondary" onPress={() => void query.refetch()}>
            {t('feedback.retry')}
          </Button>
        }
      >
        {t('feedback.loadFailed')}
      </StateHint>
    )
  if (!query.data || query.data.organizationId !== organizationId)
    return <StateHint state="loading">{t('remoteControl.loading')}</StateHint>
  return (
    <PolicyEditor
      key={`${organizationId}:${query.data.version}`}
      data={query.data}
    />
  )
}

const numericFields = [
  ['max_seconds', 30, 1800],
  ['requests_per_minute', 1, 10],
  ['rejection_cooldown_seconds', 1, 600],
] as const

const PolicyEditor = ({ data }: { data: RemoteControlPolicyView }) => {
  const { t } = useTranslation('admin')
  const { confirm } = useConfirm()
  const qc = useQueryClient()
  const [policy, setPolicy] = useState<RemoteControlPolicy>(data.policy)
  const [names, setNames] = useState(
    () => new Map(data.members.map((m) => [m.id, m.name]))
  )
  const [confirming, setConfirming] = useState(false)
  const [saved, setSaved] = useState(data.revokedSessions !== undefined)
  const queryKey = ['admin', 'remote-control-policy', data.organizationId]
  const sources = useMemo(
    () => [
      {
        value: `remote-control-${data.organizationId}`,
        label: t('remoteControl.members'),
        load: fetchRemoteControlMembers,
      },
    ],
    [data.organizationId, t]
  )
  const mutation = useMutation({
    mutationFn: (emergency: boolean) =>
      emergency
        ? closeRemoteControl()
        : saveRemoteControlPolicy(data.version, policy),
    onSuccess: (result) => {
      qc.setQueryData(queryKey, result)
      setSaved(true)
    },
  })
  const busy = mutation.isPending || confirming
  const change = <K extends keyof RemoteControlPolicy>(
    key: K,
    value: RemoteControlPolicy[K]
  ) => {
    setSaved(false)
    setPolicy((old) => ({ ...old, [key]: value }))
  }
  const apply = async (emergency: boolean) => {
    if (busy) return
    setConfirming(true)
    try {
      if (
        await confirm({
          title: t(
            emergency ? 'remoteControl.emergencyClose' : 'remoteControl.save'
          ),
          message: t(
            emergency
              ? 'remoteControl.closeConfirm'
              : 'remoteControl.saveConfirm'
          ),
          danger: emergency,
        })
      )
        mutation.mutate(emergency)
    } finally {
      setConfirming(false)
    }
  }
  const errorKey =
    mutation.error instanceof ApiError && mutation.error.statusCode === 409
      ? 'remoteControl.conflict'
      : mutation.error instanceof ApiError && mutation.error.statusCode === 400
        ? 'remoteControl.invalidMembersOrPolicy'
        : 'remoteControl.saveFailed'
  const valid = numericFields.every(
    ([field, min, max]) =>
      Number.isInteger(policy[field]) &&
      policy[field] >= min &&
      policy[field] <= max
  )
  return (
    <section className={page}>
      <header className={stack}>
        <h1 className={css({ fontSize: '1.125rem', fontWeight: 'bold' })}>
          {t('shell.nav.remoteControl')}
        </h1>
        <p>{t('remoteControl.description')}</p>
        <p>{t('remoteControl.openSessions', { count: data.openSessions })}</p>
      </header>
      {!data.globalEnabled && (
        <StateHint>{t('remoteControl.globalDisabled')}</StateHint>
      )}
      {!data.valid && (
        <StateHint state="error">{t('remoteControl.invalidStored')}</StateHint>
      )}
      {mutation.error && (
        <StateHint
          state="error"
          action={
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => void qc.invalidateQueries({ queryKey })}
            >
              {t('remoteControl.reload')}
            </Button>
          }
        >
          {t(errorKey)}
        </StateHint>
      )}
      {saved && <p role="status">{t('remoteControl.saved')}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) void apply(false)
        }}
      >
        <fieldset disabled={busy} className={stack}>
          <label className={row}>
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) => change('enabled', event.target.checked)}
            />
            {t('remoteControl.enabled')}
          </label>
          {numericFields.map(([field, min, max]) => (
            <label key={field} className={stack}>
              {t(`remoteControl.${field}`)}
              <Input
                type="number"
                required
                min={min}
                max={max}
                step={1}
                value={Number.isFinite(policy[field]) ? policy[field] : ''}
                onChange={(event) =>
                  change(
                    field,
                    event.target.value === '' ? NaN : Number(event.target.value)
                  )
                }
              />
            </label>
          ))}
          {(['controllers', 'targets'] as const).map((role) => {
            const ids = policy[role]
            const selected = new Map(
              (ids ?? []).map((id) => [
                id,
                names.get(id) ?? t('remoteControl.unavailableMember', { id }),
              ])
            )
            return (
              <section key={role} className={stack}>
                <label className={stack}>
                  {t(`remoteControl.${role}`)}
                  <select
                    className={select}
                    value={ids === null ? 'all' : 'selected'}
                    onChange={(event) =>
                      change(role, event.target.value === 'all' ? null : [])
                    }
                  >
                    <option value="all">{t('remoteControl.allMembers')}</option>
                    <option value="selected">
                      {t('remoteControl.selectedMembers')}
                    </option>
                  </select>
                </label>
                {ids !== null && (
                  <>
                    <p>
                      {t('remoteControl.allowlistHelp', { count: ids.length })}
                    </p>
                    <Suspense
                      fallback={
                        <StateHint state="loading">
                          {t('remoteControl.loading')}
                        </StateHint>
                      }
                    >
                      <DirectoryMultiPicker
                        sources={sources}
                        includeSelf
                        selected={selected}
                        onToggle={(id, name) => {
                          if (busy) return
                          if (!selected.has(id) && ids.length >= 64) return
                          setNames((old) => new Map(old).set(id, name))
                          change(
                            role,
                            selected.has(id)
                              ? ids.filter((value) => value !== id)
                              : [...ids, id]
                          )
                        }}
                        labels={{
                          searchPlaceholder: t('remoteControl.search'),
                          selectedTitle: t('remoteControl.selected', {
                            count: ids.length,
                          }),
                          loading: t('remoteControl.loading'),
                          empty: t('remoteControl.empty'),
                          loadMore: t('remoteControl.loadMore'),
                        }}
                      />
                    </Suspense>
                  </>
                )}
              </section>
            )
          })}
          <Button
            type="submit"
            variant="primary"
            isDisabled={busy || !valid}
            loading={mutation.isPending}
          >
            {t('remoteControl.save')}
          </Button>
        </fieldset>
      </form>
      <section className={stack}>
        <p>{t('remoteControl.closeHelp')}</p>
        <Button
          variant="danger"
          isDisabled={busy}
          onPress={() => void apply(true)}
        >
          {t('remoteControl.emergencyClose')}
        </Button>
      </section>
    </section>
  )
}

const page = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
  padding: '1.5rem',
  maxWidth: '960px',
  width: '100%',
})
const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  minWidth: 0,
})
const row = css({ display: 'flex', alignItems: 'center', gap: '0.5rem' })
const select = css({
  padding: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '6px',
  background: 'greyscale.000',
  color: 'default.text',
})
