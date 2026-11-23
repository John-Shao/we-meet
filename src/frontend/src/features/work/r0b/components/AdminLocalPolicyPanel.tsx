import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import { WorkApiError } from '../../r0a/api/client'
import { useWorkBootstrap } from '../../r0a/api/queries'
import { useReadOnlyViewport } from '../../r0a/hooks/useReadOnlyViewport'
import { card, errorText, muted, notice, sectionTitle } from '../../r0a/ui'
import { useSetWorkLocalPolicy, useWorkLocalPolicy } from '../api/queries'
import type {
  LocalClassification,
  WorkLocalPolicy,
  WorkLocalPolicyWrite,
} from '../api/types'

// Display choices only. 0020:125-135's CHECK constraints stay the authority: SQL refuses
// anything outside these sets, and the panel does not pre-validate membership.
const TOOLS = [
  'workspace.list',
  'workspace.read',
  'workspace.search',
  'artifact.write',
  'model.send_remote',
  'model.send_device_local',
]
const DESTINATIONS = ['device_local', 'org_private', 'org_remote']
const CLASSIFICATIONS: LocalClassification[] = [
  'local_only',
  'remote_excerpt_allowed',
]

const toggle = (values: string[], value: string) =>
  values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value]

const fieldLine = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
})

const group = css({
  margin: 0,
  padding: 0,
  border: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
})

const checkLine = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'xs',
  textStyle: 'bodyMedium',
})

const rulesBox = css({
  width: '100%',
  minHeight: '10rem',
  fontFamily: 'mono',
  textStyle: 'bodyMedium',
})

/**
 * §1.4's GET/PATCH /work/v2/admin/local-policy (0020). The gate verdict is the server's
 * local_policy_gate answer shown before the form, because the write is what decides whether
 * local actions can leave a device - the administrator must see the current revision and
 * verdict they are editing against.
 *
 * The document is edited as a closed whole (set_local_policy takes every column at once, so a
 * partial patch cannot race a second administrator on another column), and classification_rules
 * stays raw JSON: 0020:65-108 is the only validator, and re-typing the matchers in the browser
 * would be a second authority that can drift from it.
 */
export const AdminLocalPolicyPanel = () => {
  const bootstrapQ = useWorkBootstrap()
  // Split at the phase gate so an R0a-only page never mounts the v2 query at all.
  if (!bootstrapQ.data?.phases.includes('R0b')) return null
  return <LocalPolicySection />
}

const LocalPolicySection = () => {
  const { t } = useTranslation('work')
  const policyQ = useWorkLocalPolicy()
  const setPolicy = useSetWorkLocalPolicy()
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)

  const onSave = async (body: WorkLocalPolicyWrite) => {
    setFailure(null)
    setSaved(null)
    try {
      const next = await setPolicy.mutateAsync(body)
      if (next.configured) setSaved(next.revision)
    } catch (error) {
      if (
        error instanceof WorkApiError &&
        error.code === 'governance_revision_conflict'
      ) {
        // The Go face records the id but keeps no replay receipt: a resend with the same
        // expected revision is refused, so the honest recovery is to re-read and re-edit.
        setFailure(
          t('admin.localPolicy.conflict', {
            revision: error.currentRevision ?? '—',
          })
        )
        void policyQ.refetch()
        return
      }
      setFailure(t('admin.localPolicy.saveFailed'))
    }
  }

  return (
    <section className={card}>
      <h2 className={sectionTitle}>{t('admin.localPolicy.title')}</h2>
      <p className={muted}>{t('admin.localPolicy.description')}</p>
      {policyQ.isPending ? (
        <p className={muted}>{t('loading')}</p>
      ) : policyQ.isError ? (
        <>
          <p className={errorText} role="alert">
            {t('admin.localPolicy.loadFailed')}
          </p>
          <Button
            variant="secondary"
            size="dense"
            onPress={() => policyQ.refetch()}
          >
            {t('retry')}
          </Button>
        </>
      ) : policyQ.data ? (
        <>
          <p className={muted}>
            {t('admin.localPolicy.gateLabel')}:{' '}
            <strong>
              {t(`admin.localPolicy.gate.${policyQ.data.gate}`, {
                defaultValue: policyQ.data.gate,
              })}
            </strong>
            {' · '}
            {t('admin.revision')}:{' '}
            {policyQ.data.configured ? policyQ.data.revision : 0}
          </p>
          {saved !== null ? (
            <p role="status">
              {t('admin.localPolicy.saved', { revision: saved })}
            </p>
          ) : null}
          {failure ? (
            <p className={errorText} role="alert">
              {failure}
            </p>
          ) : null}
          <LocalPolicyForm
            key={policyQ.data.configured ? policyQ.data.revision : 'new'}
            policy={policyQ.data}
            saving={setPolicy.isPending}
            onSave={onSave}
          />
        </>
      ) : null}
    </section>
  )
}

const LocalPolicyForm = ({
  policy,
  saving,
  onSave,
}: {
  policy: WorkLocalPolicy
  saving: boolean
  onSave: (body: WorkLocalPolicyWrite) => void
}) => {
  const { t } = useTranslation('work')
  const readOnly = useReadOnlyViewport()
  const configured = policy.configured ? policy : null
  const [tools, setTools] = useState<string[]>(configured?.allowed_tools ?? [])
  const [destinations, setDestinations] = useState<string[]>(
    configured?.allowed_destinations ?? []
  )
  const [rulesText, setRulesText] = useState(
    JSON.stringify(configured?.classification_rules ?? [], null, 2)
  )
  const [defaultClass, setDefaultClass] = useState<LocalClassification>(
    configured?.classification_default ?? 'local_only'
  )
  const [confirmed, setConfirmed] = useState(
    configured?.classification_default_confirmed ?? false
  )
  const [floor, setFloor] = useState<LocalClassification>(
    configured?.classification_floor ?? 'local_only'
  )
  const [maxActions, setMaxActions] = useState(
    configured ? String(configured.readonly_max_actions) : ''
  )
  const [ttl, setTtl] = useState(configured?.readonly_ttl ?? '')
  const [inputLimit, setInputLimit] = useState(
    configured ? String(configured.input_limit_bytes) : ''
  )
  const [outputLimit, setOutputLimit] = useState(
    configured ? String(configured.output_limit_bytes) : ''
  )
  const [formError, setFormError] = useState<string | null>(null)

  // The confirmation is one-way in SQL (0020:298-302): once true the row can never be
  // un-confirmed, so the control follows the stored value instead of offering the change.
  const confirmationLocked =
    configured?.classification_default_confirmed === true

  const submit = () => {
    setFormError(null)
    let rules: unknown
    try {
      rules = JSON.parse(rulesText)
    } catch {
      setFormError(t('admin.localPolicy.rulesInvalid'))
      return
    }
    if (!Array.isArray(rules)) {
      setFormError(t('admin.localPolicy.rulesInvalid'))
      return
    }
    const max = Number(maxActions)
    const input = Number(inputLimit)
    const output = Number(outputLimit)
    if (
      !maxActions.trim() ||
      !Number.isInteger(max) ||
      max < 0 ||
      !Number.isInteger(input) ||
      input <= 0 ||
      !Number.isInteger(output) ||
      output <= 0 ||
      !ttl.trim()
    ) {
      setFormError(t('admin.localPolicy.numbersRequired'))
      return
    }
    onSave({
      revision: configured ? configured.revision : 0,
      client_request_id: crypto.randomUUID(),
      allowed_tools: tools,
      allowed_destinations: destinations,
      classification_rules: rules,
      classification_default: defaultClass,
      classification_default_confirmed: confirmed,
      classification_floor: floor,
      readonly_max_actions: max,
      readonly_ttl: ttl.trim(),
      input_limit_bytes: input,
      output_limit_bytes: output,
    })
  }

  return (
    <div
      className={css({ display: 'flex', flexDirection: 'column', gap: 'md' })}
    >
      {configured ? null : (
        <p className={notice}>{t('admin.localPolicy.notConfigured')}</p>
      )}
      {readOnly ? (
        <p className={notice}>{t('admin.localPolicy.mobileNotice')}</p>
      ) : null}

      <fieldset className={group} disabled={readOnly}>
        <legend className={muted}>{t('admin.localPolicy.allowedTools')}</legend>
        {TOOLS.map((tool) => (
          <label key={tool} className={checkLine}>
            <input
              type="checkbox"
              checked={tools.includes(tool)}
              onChange={() => setTools(toggle(tools, tool))}
            />
            <span>{tool}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className={group} disabled={readOnly}>
        <legend className={muted}>
          {t('admin.localPolicy.allowedDestinations')}
        </legend>
        {DESTINATIONS.map((destination) => (
          <label key={destination} className={checkLine}>
            <input
              type="checkbox"
              checked={destinations.includes(destination)}
              onChange={() =>
                setDestinations(toggle(destinations, destination))
              }
            />
            <span>{destination}</span>
          </label>
        ))}
      </fieldset>

      <label className={fieldLine}>
        <span className={muted}>{t('admin.localPolicy.rules')}</span>
        <textarea
          className={rulesBox}
          value={rulesText}
          disabled={readOnly}
          spellCheck={false}
          onChange={(event) => setRulesText(event.target.value)}
        />
      </label>

      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: { base: '1fr', md: 'repeat(2, 1fr)' },
          gap: 'md',
        })}
      >
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.default')}</span>
          <select
            value={defaultClass}
            disabled={readOnly}
            onChange={(event) =>
              setDefaultClass(event.target.value as LocalClassification)
            }
          >
            {CLASSIFICATIONS.map((classification) => (
              <option key={classification} value={classification}>
                {t(`admin.localPolicy.classification.${classification}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.floor')}</span>
          <select
            value={floor}
            disabled={readOnly}
            onChange={(event) =>
              setFloor(event.target.value as LocalClassification)
            }
          >
            {CLASSIFICATIONS.map((classification) => (
              <option key={classification} value={classification}>
                {t(`admin.localPolicy.classification.${classification}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={checkLine}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={readOnly || confirmationLocked}
            onChange={() => setConfirmed((value) => !value)}
          />
          <span>{t('admin.localPolicy.confirmed')}</span>
        </label>
        {confirmationLocked ? (
          <p className={muted}>{t('admin.localPolicy.confirmedOneWay')}</p>
        ) : null}
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.maxActions')}</span>
          <input
            type="number"
            min={0}
            value={maxActions}
            disabled={readOnly}
            onChange={(event) => setMaxActions(event.target.value)}
          />
        </label>
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.ttl')}</span>
          <input
            type="text"
            placeholder="01:00:00"
            value={ttl}
            disabled={readOnly}
            onChange={(event) => setTtl(event.target.value)}
          />
        </label>
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.inputLimit')}</span>
          <input
            type="number"
            min={1}
            value={inputLimit}
            disabled={readOnly}
            onChange={(event) => setInputLimit(event.target.value)}
          />
        </label>
        <label className={fieldLine}>
          <span className={muted}>{t('admin.localPolicy.outputLimit')}</span>
          <input
            type="number"
            min={1}
            value={outputLimit}
            disabled={readOnly}
            onChange={(event) => setOutputLimit(event.target.value)}
          />
        </label>
      </div>

      {readOnly ? null : (
        <>
          {formError ? (
            <p className={errorText} role="alert">
              {formError}
            </p>
          ) : null}
          <Button
            variant="primary"
            size="dense"
            loading={saving}
            onPress={submit}
          >
            {t('admin.localPolicy.save')}
          </Button>
        </>
      )}
    </div>
  )
}
