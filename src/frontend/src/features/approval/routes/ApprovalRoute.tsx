import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useUser } from '@/features/auth'

import { actApproval, cancelApproval, fetchApprovals } from '../api/fetchApproval'
import type {
  ApprovalInstance,
  ApprovalStatus,
} from '../api/ApiApproval'
import { SubmitApprovalDialog } from '../components/SubmitApprovalDialog'

const PENDING_KEY = ['approval', 'pending'] as const
const MINE_KEY = ['approval', 'mine'] as const

const STATUS_STYLE: Record<ApprovalStatus, { color: string; bg: string }> = {
  pending: { color: 'greyscale.700', bg: 'greyscale.100' },
  approved: { color: 'primary.700', bg: 'primary.50' },
  rejected: { color: 'danger.600', bg: 'danger.100' },
  cancelled: { color: 'greyscale.500', bg: 'greyscale.100' },
  needs_assignment: { color: 'danger.600', bg: 'danger.100' },
}

export const ApprovalRoute = () => {
  const { t } = useTranslation('approval')
  const { user, isLoggedIn } = useUser()
  if (!isLoggedIn || !user) {
    return (
      <div className={css({ padding: '2rem', color: 'greyscale.700' })}>
        {t('page.authRequired')}
      </div>
    )
  }
  return <ApprovalAuthenticated />
}

const ApprovalAuthenticated = () => {
  const { t, i18n } = useTranslation('approval')
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)

  const { data: pending = [], isLoading: loadingPending } = useQuery({
    queryKey: PENDING_KEY,
    queryFn: () => fetchApprovals('pending'),
    staleTime: 15_000,
  })
  const { data: mine = [], isLoading: loadingMine } = useQuery({
    queryKey: MINE_KEY,
    queryFn: () => fetchApprovals('mine'),
    staleTime: 15_000,
  })

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: PENDING_KEY }),
      qc.invalidateQueries({ queryKey: MINE_KEY }),
    ])

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })

  const onAct = async (
    id: string,
    action: 'approved' | 'rejected',
    comment: string
  ) => {
    try {
      await actApproval(id, action, comment)
      await refresh()
    } catch (e) {
      window.alert(t('form.error', { message: apiErrorMessage(e) }))
    }
  }
  const onCancel = async (id: string) => {
    if (!window.confirm(t('act.confirmCancel'))) return
    try {
      await cancelApproval(id)
      await refresh()
    } catch (e) {
      window.alert(t('form.error', { message: apiErrorMessage(e) }))
    }
  }

  return (
    <div
      className={css({
        maxWidth: '760px',
        margin: '0 auto',
        padding: '1.5rem 1rem',
        height: '100%',
        overflowY: 'auto',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        })}
      >
        <h1
          className={css({
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('page.title')}
        </h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="approval-create"
          className={css({
            paddingX: '1rem',
            paddingY: '0.5rem',
            border: 'none',
            borderRadius: '0.5rem',
            backgroundColor: 'primary.500',
            color: 'white',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            cursor: 'pointer',
          })}
        >
          ＋ {t('page.create')}
        </button>
      </div>

      <Section title={t('section.pending')}>
        {loadingPending ? (
          <Hint>{t('page.loading')}</Hint>
        ) : pending.length === 0 ? (
          <Hint>{t('section.empty')}</Hint>
        ) : (
          pending.map((inst) => (
            <InstanceCard
              key={inst.id}
              inst={inst}
              fmt={fmt}
              mode="pending"
              onAct={onAct}
              onCancel={onCancel}
            />
          ))
        )}
      </Section>

      <Section title={t('section.mine')}>
        {loadingMine ? (
          <Hint>{t('page.loading')}</Hint>
        ) : mine.length === 0 ? (
          <Hint>{t('section.empty')}</Hint>
        ) : (
          mine.map((inst) => (
            <InstanceCard
              key={inst.id}
              inst={inst}
              fmt={fmt}
              mode="mine"
              onAct={onAct}
              onCancel={onCancel}
            />
          ))
        )}
      </Section>

      {creating && (
        <SubmitApprovalDialog
          onClose={() => setCreating(false)}
          onSubmitted={() => {
            setCreating(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

const Section = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => (
  <section className={css({ marginBottom: '1.75rem' })}>
    <h2
      className={css({
        margin: '0 0 0.625rem',
        fontSize: '0.9375rem',
        fontWeight: 'bold',
        color: 'greyscale.800',
      })}
    >
      {title}
    </h2>
    <div
      className={css({ display: 'flex', flexDirection: 'column', gap: '0.75rem' })}
    >
      {children}
    </div>
  </section>
)

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className={css({ color: 'greyscale.500', fontSize: '0.875rem', margin: 0 })}>
    {children}
  </p>
)

const InstanceCard = ({
  inst,
  fmt,
  mode,
  onAct,
  onCancel,
}: {
  inst: ApprovalInstance
  fmt: (iso: string) => string
  mode: 'pending' | 'mine'
  onAct: (id: string, action: 'approved' | 'rejected', comment: string) => void
  onCancel: (id: string) => void
}) => {
  const { t } = useTranslation('approval')
  const [comment, setComment] = useState('')
  const badge = STATUS_STYLE[inst.status] ?? STATUS_STYLE.pending

  return (
    <div
      data-testid={`approval-${inst.id}`}
      className={css({
        border: '1px solid token(colors.greyscale.200)',
        borderRadius: '0.75rem',
        padding: '0.875rem 1rem',
        backgroundColor: 'white',
      })}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
        })}
      >
        <span className={css({ fontWeight: 'bold', color: 'greyscale.900' })}>
          {inst.template_name}
        </span>
        <span
          className={css({
            flexShrink: 0,
            paddingX: '0.5rem',
            paddingY: '0.125rem',
            borderRadius: '999px',
            fontSize: '0.6875rem',
            color: badge.color,
            backgroundColor: badge.bg,
          })}
        >
          {t(`status.${inst.status}`)}
        </span>
      </div>
      <div
        className={css({
          fontSize: '0.75rem',
          color: 'greyscale.500',
          marginTop: '0.25rem',
        })}
      >
        {t('card.applicant')}: {inst.applicant?.full_name || '—'} · {fmt(inst.created_at)}
      </div>

      {/* form data */}
      {Object.keys(inst.form_data).length > 0 && (
        <dl
          className={css({
            margin: '0.5rem 0 0',
            fontSize: '0.8125rem',
            color: 'greyscale.700',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '0.125rem 0.5rem',
          })}
        >
          {Object.entries(inst.form_data).map(([k, v]) => (
            <div key={k} className={css({ display: 'contents' })}>
              <dt className={css({ color: 'greyscale.500' })}>{k}</dt>
              <dd className={css({ margin: 0 })}>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* approver chain */}
      <ol
        className={css({
          listStyle: 'none',
          margin: '0.625rem 0 0',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
        })}
      >
        {inst.tasks.map((task) => (
          <li
            key={task.node_index}
            className={css({
              fontSize: '0.75rem',
              color:
                task.node_index === inst.current_node &&
                inst.status === 'pending'
                  ? 'greyscale.900'
                  : 'greyscale.500',
            })}
          >
            {t('card.node', { index: task.node_index + 1 })}：
            {task.approver?.full_name || t('card.unassigned')}
            {task.action !== 'pending' && ` · ${t(`status.${task.action}`)}`}
            {task.comment && ` · ${task.comment}`}
          </li>
        ))}
      </ol>

      {/* actions */}
      {mode === 'pending' && inst.status === 'pending' && (
        <div className={css({ marginTop: '0.75rem' })}>
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('act.commentPlaceholder')}
            className={css({
              width: '100%',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              padding: '0.375rem 0.5rem',
              fontSize: '0.8125rem',
              marginBottom: '0.5rem',
            })}
          />
          <div className={css({ display: 'flex', gap: '0.5rem' })}>
            <button
              type="button"
              onClick={() => onAct(inst.id, 'approved', comment)}
              data-testid={`approval-approve-${inst.id}`}
              className={css({
                paddingX: '0.875rem',
                paddingY: '0.375rem',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'primary.500',
                color: 'white',
                fontSize: '0.8125rem',
                cursor: 'pointer',
              })}
            >
              {t('act.approve')}
            </button>
            <button
              type="button"
              onClick={() => onAct(inst.id, 'rejected', comment)}
              data-testid={`approval-reject-${inst.id}`}
              className={css({
                paddingX: '0.875rem',
                paddingY: '0.375rem',
                border: '1px solid token(colors.danger.300)',
                borderRadius: '0.5rem',
                backgroundColor: 'white',
                color: 'danger.600',
                fontSize: '0.8125rem',
                cursor: 'pointer',
              })}
            >
              {t('act.reject')}
            </button>
          </div>
        </div>
      )}

      {mode === 'mine' && inst.status === 'pending' && (
        <div className={css({ marginTop: '0.625rem' })}>
          <button
            type="button"
            onClick={() => onCancel(inst.id)}
            className={css({
              paddingX: '0.75rem',
              paddingY: '0.3125rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              backgroundColor: 'white',
              color: 'greyscale.700',
              fontSize: '0.8125rem',
              cursor: 'pointer',
            })}
          >
            {t('act.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}
