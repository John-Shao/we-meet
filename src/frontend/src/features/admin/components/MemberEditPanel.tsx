import { SelectCompat } from '@/primitives/SelectCompat'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button, Input } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { StateHint } from '@/components/StateHint'

import {
  type AdminMember,
  type UpdateMembershipInput,
  ORG_ROLES,
  fetchAdminMembers,
  updateMembership,
} from '../api/adminMembers'
import { fetchDictItems } from '../api/adminDictionaries'
import type { AdminDepartment } from '../api/adminDepartments'
import { describeApiError } from '../api/errors'

interface Props {
  member: AdminMember | null
  departments: AdminDepartment[]
  onClose: () => void
}

/**
 * Edit one member's full profile, laid out in the three sections 飞书 uses in its
 * 添加成员 dialog: 基础信息 / 工作信息 / 其他信息.
 *
 * Identity fields (name, phone, email) are read-only: they come from the OIDC
 * provider, and letting an admin edit them here would only create a second
 * truth that the next login overwrites.
 */
export const MemberEditPanel = ({ member, departments, onClose }: Props) => {
  const { t } = useTranslation('admin')
  const queryClient = useQueryClient()
  const { alert: showAlert } = useConfirm()
  const [form, setForm] = useState<UpdateMembershipInput>({})

  // Reset the draft whenever a different member is opened.
  useEffect(() => {
    if (!member) return
    setForm({
      department: member.department?.id ?? null,
      org_role: member.org_role,
      title: member.title,
      employee_no: member.employee_no,
      employee_type: member.employee_type?.id ?? null,
      job_level: member.job_level?.id ?? null,
      job_sequence: member.job_sequence?.id ?? null,
      manager: member.manager?.membership_id ?? null,
      dotted_manager: member.dotted_manager?.membership_id ?? null,
      hire_date: member.hire_date,
      work_country: member.work_country,
      work_city: member.work_city,
      alias: member.alias,
      work_station: member.work_station,
      extension: member.extension,
    })
  }, [member])

  const enabled = member !== null
  const {
    data: employeeTypes = [],
    isFetching: employeeTypesFetching,
    isError: employeeTypesError,
    refetch: refetchEmployeeTypes,
  } = useQuery({
    queryKey: ['admin', 'dict', 'employee_type'],
    queryFn: () => fetchDictItems('employee_type'),
    staleTime: 5 * 60_000,
    enabled,
  })
  const {
    data: jobLevels = [],
    isFetching: jobLevelsFetching,
    isError: jobLevelsError,
    refetch: refetchJobLevels,
  } = useQuery({
    queryKey: ['admin', 'dict', 'job_level'],
    queryFn: () => fetchDictItems('job_level'),
    staleTime: 5 * 60_000,
    enabled,
  })
  const {
    data: jobSequences = [],
    isFetching: jobSequencesFetching,
    isError: jobSequencesError,
    refetch: refetchJobSequences,
  } = useQuery({
    queryKey: ['admin', 'dict', 'job_sequence'],
    queryFn: () => fetchDictItems('job_sequence'),
    staleTime: 5 * 60_000,
    enabled,
  })
  // Candidate managers: active members only. One page is enough for the picker
  // in an org small enough to be administered by hand; larger orgs get search
  // in a later milestone.
  const {
    data: candidates,
    isFetching: candidatesFetching,
    isError: candidatesError,
    refetch: refetchCandidates,
  } = useQuery({
    queryKey: ['admin', 'members', 'manager-candidates'],
    queryFn: () => fetchAdminMembers({ status: 'active' }),
    staleTime: 60_000,
    enabled,
  })

  const save = useMutation({
    mutationFn: (input: UpdateMembershipInput) =>
      updateMembership(member!.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'members'] })
      onClose()
    },
    onError: (e) => showAlert({ message: describeApiError(e) }),
  })

  if (!member) return null

  const displayName =
    member.full_name || member.short_name || member.email || member.sub || ''
  const set = <K extends keyof UpdateMembershipInput>(
    key: K,
    value: UpdateMembershipInput[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }))

  const managerOptions = (candidates?.results ?? []).filter(
    (m) => m.id !== member.id
  )
  const lookupsLoading =
    (employeeTypesFetching && employeeTypes.length === 0) ||
    (jobLevelsFetching && jobLevels.length === 0) ||
    (jobSequencesFetching && jobSequences.length === 0) ||
    (candidatesFetching && !candidates)
  const lookupsError =
    (employeeTypesError && employeeTypes.length === 0) ||
    (jobLevelsError && jobLevels.length === 0) ||
    (jobSequencesError && jobSequences.length === 0) ||
    (candidatesError && !candidates)
  const refetchLookups = () => {
    void Promise.all([
      refetchEmployeeTypes(),
      refetchJobLevels(),
      refetchJobSequences(),
      refetchCandidates(),
    ])
  }

  return (
    <>
      <div className={scrimCls} onClick={onClose} aria-hidden />
      <aside
        className={panelCls}
        role="dialog"
        aria-label={t('members.editTitle', { name: displayName })}
      >
        <header className={headerCls}>
          <div className={css({ minWidth: 0 })}>
            <div className={titleCls}>{displayName}</div>
            <div className={subtitleCls}>{member.email}</div>
          </div>
          <Button variant="quaternaryText" size="sm" onPress={onClose}>
            {t('actions.close')}
          </Button>
        </header>

        <div className={bodyCls}>
          {lookupsLoading ? (
            <StateHint className={lookupStateCls} state="loading">
              {t('dashboard.loading')}
            </StateHint>
          ) : lookupsError ? (
            <StateHint
              className={lookupStateCls}
              state="error"
              action={
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={refetchLookups}
                >
                  {t('feedback.retry')}
                </Button>
              }
            >
              {t('feedback.loadFailed')}
            </StateHint>
          ) : null}
          <Section title={t('members.sectionBasic')}>
            {/* Identity comes from the IdP — editable here would be a second truth. */}
            <ReadOnlyRow label={t('members.colMember')} value={displayName} />
            <ReadOnlyRow
              label={t('invite.email')}
              value={member.email ?? '—'}
            />
            <SelectRow
              label={t('members.colDepartment')}
              value={form.department ?? ''}
              onChange={(v) => set('department', v || null)}
              options={[
                { value: '', label: t('members.orgLevel') },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
            <SelectRow
              label={t('members.colRole')}
              value={form.org_role ?? 'member'}
              onChange={(v) => set('org_role', v)}
              options={ORG_ROLES.map((r) => ({
                value: r,
                label: t(`role.${r}`, { defaultValue: r }),
              }))}
            />
          </Section>

          <Section title={t('members.sectionWork')}>
            <SelectRow
              label={t('members.employeeType')}
              value={form.employee_type ?? ''}
              onChange={(v) => set('employee_type', v || null)}
              options={[
                { value: '', label: '—' },
                ...employeeTypes.map((d) => ({ value: d.id, label: d.label })),
              ]}
            />
            <TextRow
              label={t('members.changeTitle')}
              value={form.title ?? ''}
              onChange={(v) => set('title', v)}
            />
            <SelectRow
              label={t('members.jobLevel')}
              value={form.job_level ?? ''}
              onChange={(v) => set('job_level', v || null)}
              options={[
                { value: '', label: '—' },
                ...jobLevels.map((d) => ({ value: d.id, label: d.label })),
              ]}
            />
            <SelectRow
              label={t('members.jobSequence')}
              value={form.job_sequence ?? ''}
              onChange={(v) => set('job_sequence', v || null)}
              options={[
                { value: '', label: '—' },
                ...jobSequences.map((d) => ({ value: d.id, label: d.label })),
              ]}
            />
            <TextRow
              label={t('members.hireDate')}
              type="date"
              value={form.hire_date ?? ''}
              onChange={(v) => set('hire_date', v || null)}
            />
            <TextRow
              label={t('members.workCity')}
              value={form.work_city ?? ''}
              onChange={(v) => set('work_city', v)}
            />
            <SelectRow
              label={t('members.manager')}
              value={form.manager ?? ''}
              onChange={(v) => set('manager', v || null)}
              options={[
                { value: '', label: '—' },
                ...managerOptions.map((m) => ({
                  value: m.id,
                  label: m.full_name || m.email || m.id,
                })),
              ]}
            />
            <SelectRow
              label={t('members.dottedManager')}
              hint={t('members.dottedManagerHint')}
              value={form.dotted_manager ?? ''}
              onChange={(v) => set('dotted_manager', v || null)}
              options={[
                { value: '', label: '—' },
                ...managerOptions.map((m) => ({
                  value: m.id,
                  label: m.full_name || m.email || m.id,
                })),
              ]}
            />
          </Section>

          <Section title={t('members.sectionOther')}>
            <TextRow
              label={t('members.employeeNo')}
              value={form.employee_no ?? ''}
              onChange={(v) => set('employee_no', v)}
            />
            <TextRow
              label={t('members.alias')}
              value={form.alias ?? ''}
              onChange={(v) => set('alias', v)}
            />
            <TextRow
              label={t('members.workStation')}
              value={form.work_station ?? ''}
              onChange={(v) => set('work_station', v)}
            />
            <TextRow
              label={t('members.extension')}
              value={form.extension ?? ''}
              onChange={(v) => set('extension', v)}
            />
            <ReadOnlyRow label={t('members.source')} value={member.source} />
          </Section>
        </div>

        <footer className={footerCls}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={save.isPending}
            loading={save.isPending}
            onPress={() => save.mutate(form)}
          >
            {t('actions.save')}
          </Button>
        </footer>
      </aside>
    </>
  )
}

const Section = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => (
  <section className={css({ marginBottom: '1.5rem' })}>
    <h3 className={sectionTitleCls}>{title}</h3>
    {children}
  </section>
)

const Row = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) => (
  <label className={rowCls}>
    <span className={labelCls}>
      {label}
      {hint && <span className={hintCls}>{hint}</span>}
    </span>
    {children}
  </label>
)

const ReadOnlyRow = ({ label, value }: { label: string; value: string }) => (
  <Row label={label}>
    <span className={readOnlyCls}>{value || '—'}</span>
  </Row>
)

const TextRow = ({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) => (
  <Row label={label}>
    <Input
      type={type}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  </Row>
)

const SelectRow = ({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) => (
  <Row label={label} hint={hint}>
    <SelectCompat
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </SelectCompat>
  </Row>
)

const scrimCls = css({
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.32)',
  zIndex: 'modal',
})
const panelCls = css({
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(440px, 100vw)',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'greyscale.000',
  borderLeft: '1px solid token(colors.greyscale.200)',
  zIndex: 'modal',
})
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  padding: '1rem 1.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const subtitleCls = css({ fontSize: '0.8125rem', color: 'greyscale.500' })
const bodyCls = css({ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' })
const lookupStateCls = css({
  alignItems: 'flex-start',
  padding: 'sm',
  marginBottom: 'md',
  textAlign: 'left',
})
const footerCls = css({
  flexShrink: 0,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  padding: '0.875rem 1.25rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const sectionTitleCls = css({
  fontSize: '0.8125rem',
  fontWeight: '600',
  color: 'greyscale.600',
  marginBottom: '0.625rem',
  paddingBottom: '0.375rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const rowCls = css({
  display: 'grid',
  gridTemplateColumns: '7rem 1fr',
  alignItems: 'center',
  gap: '0.75rem',
  marginBottom: '0.625rem',
})
const labelCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  display: 'flex',
  flexDirection: 'column',
})
const hintCls = css({ fontSize: '0.6875rem', color: 'greyscale.400' })
const readOnlyCls = css({ fontSize: '0.875rem', color: 'greyscale.800' })
