import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import {
  useAdminProviderConfig,
  useCreateAdminProviderCredential,
  useRevokeAdminProviderConfig,
  useRevokeAdminProviderCredential,
  useRotateAdminProviderCredential,
  useSetAdminProviderConfig,
} from '../api/queries'
import { card, muted, notice } from '../ui'

const PROVIDERS = ['aliyun', 'volcengine', 'deepseek'] as const
const MODES = ['sts_role', 'managed_key'] as const

type ProviderName = (typeof PROVIDERS)[number]
type CredentialMode = (typeof MODES)[number]

const field = (label: string, control: React.ReactNode) => (
  <label
    className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
  >
    <span className={muted}>{label}</span>
    {control}
  </label>
)

const readCode = (error: unknown, key: 'code' | 'status') => {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined
}

// The owner-only write face for D-08d: the organization's own model access. The admin page
// already showed the current configuration read-only; without these five calls the only way to
// point Work at a customer's account was to hand-write HTTP requests, so the signed scope had an
// implementation on the server and none on the screen.
//
// Two rules the shape of the API forces on us: an api_key is write-only, so it is never echoed
// back and each field that carries one is cleared as soon as the call returns; and the PUT is
// versioned, so the revision the form was built from travels as expected_revision and a 409 is
// shown as "someone else changed this" rather than silently retried.
export const AdminProviderPanel = () => {
  const { t } = useTranslation('work')
  const configQ = useAdminProviderConfig()
  const setConfig = useSetAdminProviderConfig()
  const revokeConfig = useRevokeAdminProviderConfig()
  const createCredential = useCreateAdminProviderCredential()
  const rotateCredential = useRotateAdminProviderCredential()
  const revokeCredential = useRevokeAdminProviderCredential()

  const config = configQ.data
  const [provider, setProvider] = useState<ProviderName>('aliyun')
  const [model, setModel] = useState('')
  const [region, setRegion] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [mode, setMode] = useState<CredentialMode>('managed_key')
  const [credentialId, setCredentialId] = useState('')
  const [roleRef, setRoleRef] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<string>()

  // Prefilled from the live configuration the first time it arrives, so the form is an edit of
  // what is in effect rather than a blank request that would overwrite it with defaults.
  const [seeded, setSeeded] = useState(false)
  if (config && !seeded) {
    setSeeded(true)
    setProvider(config.provider as ProviderName)
    setModel(config.model)
    setRegion(config.region)
    setEndpoint(config.endpoint)
    setMode(config.credential_mode as CredentialMode)
    setCredentialId(config.credential?.credential_id ?? '')
  }

  const failure = (error: unknown) => {
    const code = readCode(error, 'code')
    if (code === 'version_conflict') return t('admin.providerConflict')
    return typeof code === 'string'
      ? t('admin.providerFailed', { code })
      : t('admin.providerFailed', { code: 'unknown' })
  }

  return (
    <section className={card}>
      <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
        {t('admin.providerTitle')}
      </h2>
      {configQ.isPending ? (
        <p className={muted}>{t('loading')}</p>
      ) : (
        <>
          <dl
            className={css({
              display: 'grid',
              gridTemplateColumns: { base: '1fr', md: 'repeat(3, 1fr)' },
              gap: 'md',
              margin: 0,
            })}
          >
            {(
              [
                [t('admin.state'), config?.state ?? '—'],
                [t('admin.revision'), config ? String(config.revision) : '0'],
                [
                  t('admin.fingerprint'),
                  config?.credential?.fingerprint ?? '—',
                ],
                [
                  t('admin.credentialVersion'),
                  config?.credential
                    ? String(config.credential.key_version)
                    : '—',
                ],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt className={muted}>{label}</dt>
                <dd className={css({ margin: 0, wordBreak: 'break-all' })}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <div
            className={css({
              display: 'grid',
              gap: 'sm',
              gridTemplateColumns: { base: '1fr', md: 'repeat(3, 1fr)' },
              marginY: 'md',
            })}
          >
            {field(
              t('admin.providerField'),
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderName)}
              >
                {PROVIDERS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
            {field(
              t('admin.modelField'),
              <input value={model} onChange={(e) => setModel(e.target.value)} />
            )}
            {field(
              t('admin.regionField'),
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            )}
            {field(
              t('admin.endpointField'),
              <input
                value={endpoint}
                placeholder="https://…"
                onChange={(e) => setEndpoint(e.target.value)}
              />
            )}
            {field(
              t('admin.credentialMode'),
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as CredentialMode)}
              >
                {MODES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
            {field(
              t('admin.credentialId'),
              <input
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
              />
            )}
          </div>

          <div
            className={css({ display: 'flex', gap: 'sm', flexWrap: 'wrap' })}
          >
            <Button
              variant="primary"
              size="dense"
              loading={setConfig.isPending}
              isDisabled={
                !model || !endpoint.startsWith('https://') || !credentialId
              }
              onPress={async () => {
                try {
                  const saved = await setConfig.mutateAsync({
                    provider,
                    model,
                    region,
                    endpoint,
                    credential_mode: mode,
                    credential_id: credentialId,
                    expected_revision: config?.revision ?? 0,
                  })
                  setApiKey('')
                  setStatus(
                    t('admin.providerSaved', { revision: saved.revision })
                  )
                } catch (error) {
                  setStatus(failure(error))
                }
              }}
            >
              {t('admin.providerSave')}
            </Button>
            <Button
              variant="secondary"
              size="dense"
              loading={revokeConfig.isPending}
              isDisabled={!reason}
              onPress={async () => {
                try {
                  await revokeConfig.mutateAsync({ reason })
                  setStatus(t('admin.providerRevoked'))
                } catch (error) {
                  setStatus(failure(error))
                }
              }}
            >
              {t('admin.providerRevoke')}
            </Button>
          </div>

          <div
            className={css({
              display: 'flex',
              gap: 'sm',
              flexWrap: 'wrap',
              alignItems: 'end',
              marginY: 'md',
            })}
          >
            {field(
              t('admin.roleRef'),
              <input
                value={roleRef}
                onChange={(e) => setRoleRef(e.target.value)}
              />
            )}
            {field(
              t('admin.apiKey'),
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
            {field(
              t('admin.reason'),
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </div>

          <div
            className={css({ display: 'flex', gap: 'sm', flexWrap: 'wrap' })}
          >
            <Button
              variant="secondary"
              size="dense"
              loading={createCredential.isPending}
              isDisabled={
                (mode === 'managed_key' && apiKey.length < 8) ||
                (mode === 'sts_role' && !roleRef)
              }
              onPress={async () => {
                try {
                  const created = await createCredential.mutateAsync({
                    provider,
                    mode,
                    ...(mode === 'sts_role' ? { role_ref: roleRef } : {}),
                    ...(mode === 'managed_key' ? { api_key: apiKey } : {}),
                  })
                  // The response carries only the fingerprint and the id, which is exactly the
                  // moment the id is usable: adopt it so the owner can save without copying.
                  setCredentialId(created.credential_id)
                  setApiKey('')
                  setStatus(
                    t('admin.credentialCreated', {
                      fingerprint: created.fingerprint,
                    })
                  )
                } catch (error) {
                  setStatus(failure(error))
                }
              }}
            >
              {t('admin.credentialCreate')}
            </Button>
            <Button
              variant="secondary"
              size="dense"
              loading={rotateCredential.isPending}
              isDisabled={!credentialId || apiKey.length < 8}
              onPress={async () => {
                try {
                  const rotated = await rotateCredential.mutateAsync({
                    credentialId,
                    body: { api_key: apiKey },
                  })
                  setApiKey('')
                  setStatus(
                    t('admin.credentialRotated', {
                      version: rotated.key_version,
                    })
                  )
                } catch (error) {
                  setStatus(failure(error))
                }
              }}
            >
              {t('admin.credentialRotate')}
            </Button>
            <Button
              variant="danger"
              size="dense"
              loading={revokeCredential.isPending}
              isDisabled={!credentialId || !reason}
              onPress={async () => {
                try {
                  await revokeCredential.mutateAsync({
                    credentialId,
                    body: { reason },
                  })
                  setStatus(t('admin.credentialRevoked'))
                } catch (error) {
                  setStatus(failure(error))
                }
              }}
            >
              {t('admin.credentialRevoke')}
            </Button>
          </div>

          <p className={notice}>
            {status ??
              (configQ.isError
                ? t('admin.providerEmpty')
                : t('admin.providerHint'))}
          </p>
        </>
      )}
    </section>
  )
}
