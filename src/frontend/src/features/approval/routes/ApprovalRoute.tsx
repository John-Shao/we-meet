import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RiAddCircleLine,
  RiInboxLine,
  RiSendPlaneLine,
  RiFileList3Line,
} from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useUser } from '@/features/auth'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'

import {
  actApproval,
  cancelApproval,
  fetchApprovals,
  fetchApprovalTemplates,
} from '../api/fetchApproval'
import type {
  ApprovalInstance,
  ApprovalStatus,
  ApprovalTemplate,
} from '../api/ApiApproval'
import { SubmitApprovalDialog } from '../components/SubmitApprovalDialog'

const PENDING_KEY = ['approval', 'pending'] as const
const MINE_KEY = ['approval', 'mine'] as const

type ApprovalView = 'create' | 'pending' | 'mine'

/** Feishu-style colour rotation for the 发起申请 template cards (templates
 *  carry no colour of their own — derive a stable one from list order). */
const CARD_PALETTE = [
  '#3370FF',
  '#F5222D',
  '#52C41A',
  '#FA8C16',
  '#722ED1',
  '#13C2C2',
  '#EB2F96',
]

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
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const [view, setView] = useState<ApprovalView>('pending')
  const [submitOpen, setSubmitOpen] = useState(false)
  const [presetTemplate, setPresetTemplate] = useState<string | undefined>()

  const openSubmit = (templateId?: string) => {
    setPresetTemplate(templateId)
    setSubmitOpen(true)
  }
  const closeSubmit = () => {
    setSubmitOpen(false)
    setPresetTemplate(undefined)
  }

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
  const { data: templates = [], isLoading: loadingTemplates } = useQuery({
    queryKey: ['approval', 'templates'],
    queryFn: fetchApprovalTemplates,
    staleTime: 60_000,
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
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
    }
  }
  const onCancel = async (id: string) => {
    if (!(await askConfirm({ message: t('act.confirmCancel'), danger: true })))
      return
    try {
      await cancelApproval(id)
      await refresh()
    } catch (e) {
      void showAlert({ message: t('form.error', { message: apiErrorMessage(e) }) })
    }
  }

  const list = view === 'pending' ? pending : mine
  const loadingList = view === 'pending' ? loadingPending : loadingMine

  return (
    <div className={css({ display: 'flex', height: '100%' })}>
      {/* 二级导航栏:发起申请 / 待办 / 我发起,与其它模块对齐,可拖拽改宽。 */}
      <ResizablePanel
        storageKey="we-meet:approval-sidebar-width"
        defaultWidth={230}
        min={200}
        max={400}
      >
        <nav
          aria-label={t('page.title')}
          className={css({
            width: '100%',
            height: '100%',
            borderRight: '1px solid token(colors.greyscale.200)',
            backgroundColor: 'white',
            padding: '1rem 0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
            overflowY: 'auto',
          })}
        >
          <h1
            className={css({
              margin: '0 0 0.5rem',
              paddingX: '0.5rem',
              fontSize: '1.125rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('page.title')}
          </h1>
          <NavItem
            icon={<RiAddCircleLine size={18} />}
            label={t('tab.create')}
            active={view === 'create'}
            onClick={() => setView('create')}
          />
          <NavItem
            icon={<RiInboxLine size={18} />}
            label={t('tab.pending')}
            active={view === 'pending'}
            badge={pending.length}
            onClick={() => setView('pending')}
          />
          <NavItem
            icon={<RiSendPlaneLine size={18} />}
            label={t('tab.mine')}
            active={view === 'mine'}
            onClick={() => setView('mine')}
          />
        </nav>
      </ResizablePanel>

      <main
        className={css({
          flex: 1,
          minWidth: 0,
          height: '100%',
          overflowY: 'auto',
          padding: '1.5rem',
        })}
      >
        {view === 'create' ? (
          <>
            <h2 className={contentTitle}>{t('tab.create')}</h2>
            {loadingTemplates ? (
              <Hint>{t('page.loading')}</Hint>
            ) : templates.length === 0 ? (
              <Hint>{t('form.noTemplates')}</Hint>
            ) : (
              <div
                className={css({
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                  gap: '0.875rem',
                })}
              >
                {templates.map((tpl, i) => (
                  <TemplateCard
                    key={tpl.id}
                    tpl={tpl}
                    color={CARD_PALETTE[i % CARD_PALETTE.length]}
                    onPick={() => openSubmit(tpl.id)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <h2 className={contentTitle}>
              {view === 'pending' ? t('tab.pending') : t('tab.mine')}
            </h2>
            <div
              className={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                maxWidth: '760px',
              })}
            >
              {loadingList ? (
                <Hint>{t('page.loading')}</Hint>
              ) : list.length === 0 ? (
                <Hint>{t('section.empty')}</Hint>
              ) : (
                list.map((inst) => (
                  <InstanceCard
                    key={inst.id}
                    inst={inst}
                    fmt={fmt}
                    mode={view === 'pending' ? 'pending' : 'mine'}
                    onAct={onAct}
                    onCancel={onCancel}
                  />
                ))
              )}
            </div>
          </>
        )}
      </main>

      {submitOpen && (
        <SubmitApprovalDialog
          initialTemplateId={presetTemplate}
          onClose={closeSubmit}
          onSubmitted={() => {
            closeSubmit()
            void refresh()
          }}
        />
      )}
    </div>
  )
}

const contentTitle = css({
  margin: '0 0 1rem',
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

const navItemBase = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  borderRadius: '8px',
  fontSize: '0.875rem',
  color: 'greyscale.700',
  cursor: 'pointer',
  border: 'none',
  backgroundColor: 'transparent',
  textAlign: 'left',
  width: '100%',
  _hover: { backgroundColor: 'greyscale.100' },
})
const navItemActive = css({
  backgroundColor: 'primary.100',
  color: 'primary.600',
  fontWeight: '500',
})

const NavItem = ({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cx(navItemBase, active ? navItemActive : undefined)}
  >
    {icon}
    <span className={css({ flex: 1 })}>{label}</span>
    {badge != null && badge > 0 && (
      <span
        className={css({
          minWidth: '18px',
          height: '18px',
          paddingX: '0.25rem',
          borderRadius: '999px',
          backgroundColor: 'danger.500',
          color: 'white',
          fontSize: '0.6875rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        })}
      >
        {badge}
      </span>
    )}
  </button>
)

const TemplateCard = ({
  tpl,
  color,
  onPick,
}: {
  tpl: ApprovalTemplate
  color: string
  onPick: () => void
}) => (
  <button
    type="button"
    onClick={onPick}
    data-testid={`approval-template-${tpl.id}`}
    className={css({
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '1rem',
      border: '1px solid token(colors.greyscale.200)',
      borderRadius: '0.75rem',
      backgroundColor: 'white',
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'border-color 0.15s, box-shadow 0.15s',
      _hover: {
        borderColor: 'primary.300',
        boxShadow: '0 2px 8px rgba(51,112,255,0.12)',
      },
    })}
  >
    <span
      className={css({
        flexShrink: 0,
        width: '40px',
        height: '40px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '10px',
        color: 'white',
      })}
      style={{ backgroundColor: color }}
    >
      <RiFileList3Line size={22} />
    </span>
    <span className={css({ minWidth: 0 })}>
      <span
        className={css({
          display: 'block',
          fontWeight: 600,
          color: 'greyscale.900',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        {tpl.name}
      </span>
      {tpl.description && (
        <span
          className={css({
            display: 'block',
            fontSize: '0.75rem',
            color: 'greyscale.500',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {tpl.description}
        </span>
      )}
    </span>
  </button>
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
