import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  RiAddCircleLine,
  RiInboxLine,
  RiSendPlaneLine,
  RiFileList3Line,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import {
  actApproval,
  cancelApproval,
  fetchApprovalsPage,
  fetchApprovalTemplates,
  urgeApproval,
} from '../api/fetchApproval'
import type {
  ApprovalInstance,
  ApprovalStatus,
  ApprovalTemplate,
} from '../api/ApiApproval'
import { SubmitApprovalDialog } from '../components/SubmitApprovalDialog'

// Sibling keys to the rail-badge query (['approval','pending']) so the infinite
// list's page-shaped cache never collides with the badge's array-shaped cache.
const PENDING_LIST_KEY = ['approval', 'pending-list'] as const
const MINE_LIST_KEY = ['approval', 'mine-list'] as const
const PENDING_BADGE_KEY = ['approval', 'pending'] as const

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

const statusBadgeBase = {
  flexShrink: 0,
  paddingX: '0.5rem',
  paddingY: '0.125rem',
  borderRadius: '999px',
  fontSize: '0.6875rem',
} as const

// 每个状态存一条**完整的 css() 类名**,不是 {color, bg} 字符串对。
// panda 是静态提取:写成 `backgroundColor: badge.bg` 那种动态取值,它看不到
// 字面量,一个原子类都不会生成 —— 之前徽章能显示纯属别的文件恰好用过同名
// token,漏网的档位(如 IM 状态条的 warning.*)就直接没有底色。
//
// 配色一律走会翻转的语义 token(danger.subtle / brand.* / greyscale.*):
// 文字用的 greyscale 会随主题翻转,底色钉死浅色就是浅字压浅底。
const STATUS_CLS: Record<ApprovalStatus, string> = {
  pending: css({
    ...statusBadgeBase,
    color: 'greyscale.700',
    backgroundColor: 'greyscale.100',
  }),
  approved: css({
    ...statusBadgeBase,
    color: 'brand.700',
    backgroundColor: 'brand.50',
  }),
  rejected: css({
    ...statusBadgeBase,
    color: 'danger.subtle-text',
    backgroundColor: 'danger.subtle',
  }),
  cancelled: css({
    ...statusBadgeBase,
    color: 'greyscale.500',
    backgroundColor: 'greyscale.100',
  }),
  needs_assignment: css({
    ...statusBadgeBase,
    color: 'danger.subtle-text',
    backgroundColor: 'danger.subtle',
  }),
}

export const ApprovalRoute = () => (
  <RequireAuth>
    <Screen>
      <ApprovalAuthenticated />
    </Screen>
  </RequireAuth>
)

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

  const pendingQ = useInfiniteQuery({
    queryKey: PENDING_LIST_KEY,
    queryFn: ({ pageParam }) => fetchApprovalsPage('pending', pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      last.next ? pages.length + 1 : undefined,
    staleTime: 15_000,
  })
  const mineQ = useInfiniteQuery({
    queryKey: MINE_LIST_KEY,
    queryFn: ({ pageParam }) => fetchApprovalsPage('mine', pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      last.next ? pages.length + 1 : undefined,
    staleTime: 15_000,
  })
  const pending = pendingQ.data?.pages.flatMap((p) => p.results) ?? []
  const mine = mineQ.data?.pages.flatMap((p) => p.results) ?? []
  // 徽标用服务端总数(count),而非已加载页的条数。
  const pendingCount = pendingQ.data?.pages[0]?.count ?? pending.length
  const loadingPending = pendingQ.isLoading
  const loadingMine = mineQ.isLoading

  const { data: templates = [], isLoading: loadingTemplates } = useQuery({
    queryKey: ['approval', 'templates'],
    queryFn: fetchApprovalTemplates,
    staleTime: 60_000,
  })

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: PENDING_LIST_KEY }),
      qc.invalidateQueries({ queryKey: MINE_LIST_KEY }),
      qc.invalidateQueries({ queryKey: PENDING_BADGE_KEY }),
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
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }
  const onCancel = async (id: string) => {
    if (!(await askConfirm({ message: t('act.confirmCancel'), danger: true })))
      return
    try {
      await cancelApproval(id)
      await refresh()
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }
  const onUrge = async (id: string) => {
    try {
      await urgeApproval(id)
      // 催办无状态变化,给一句确认反馈(否则用户不知点了有没有用)。
      void showAlert({ message: t('act.urged') })
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
    }
  }

  const list = view === 'pending' ? pending : mine
  const loadingList = view === 'pending' ? loadingPending : loadingMine
  const activeQ = view === 'pending' ? pendingQ : mineQ

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
            backgroundColor: 'greyscale.000',
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
            badge={pendingCount}
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
                <>
                  {list.map((inst) => (
                    <InstanceCard
                      key={inst.id}
                      inst={inst}
                      fmt={fmt}
                      mode={view === 'pending' ? 'pending' : 'mine'}
                      onAct={onAct}
                      onCancel={onCancel}
                      onUrge={onUrge}
                    />
                  ))}
                  {activeQ.hasNextPage && (
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => void activeQ.fetchNextPage()}
                      isDisabled={activeQ.isFetchingNextPage}
                      data-testid="approval-load-more"
                      className={css({
                        alignSelf: 'center',
                        marginTop: '0.25rem',
                        color: 'greyscale.700',
                        borderColor: 'greyscale.300',
                      })}
                    >
                      {activeQ.isFetchingNextPage
                        ? t('page.loading')
                        : t('act.loadMore')}
                    </Button>
                  )}
                </>
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

// 布局与状态拆开:cx 叠加同属性原子类按样式表顺序取胜,active 的 bg/color
// 曾依赖顺序侥幸生效(见 memory: panda-cx-atomic-order-trap)。
const navItemBase = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  borderRadius: '8px',
  fontSize: '0.875rem',
  cursor: 'pointer',
  border: 'none',
  textAlign: 'left',
  width: '100%',
})
const navItemIdle = css({
  color: 'greyscale.700',
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.100' },
})
const navItemActive = css({
  // 与 /admin 左栏、部门树、会议室层级树同一套选中态语义 token(深浅成对)。
  backgroundColor: 'selected.bg',
  color: 'selected.text',
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
    className={cx(navItemBase, active ? navItemActive : navItemIdle)}
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
      backgroundColor: 'greyscale.000',
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
  <p
    className={css({ color: 'greyscale.500', fontSize: '0.875rem', margin: 0 })}
  >
    {children}
  </p>
)

const chainRow = (active: boolean) =>
  css({
    fontSize: '0.75rem',
    color: active ? 'greyscale.900' : 'greyscale.500',
  })

/**
 * 审批链时间线,按节点分组(P5b):
 * - 单签节点 → 一行(审批人 · 状态 · 意见)。
 * - 会签节点(≥2 审批人)→ 「并签/或签 · N/M 已批」+ 各审批人明细。
 * - 抄送节点 → 「抄送:张三、李四」。
 * - 条件跳过节点 → 「已跳过」淡显。
 */
const NodeChain = ({ inst }: { inst: ApprovalInstance }) => {
  const { t } = useTranslation('approval')
  const nodeIndexes = [...new Set(inst.tasks.map((x) => x.node_index))].sort(
    (a, b) => a - b
  )
  const modeOf = (idx: number) =>
    inst.nodes?.find((n) => n.index === idx)?.mode ?? 'single'

  return (
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
      {nodeIndexes.map((idx) => {
        const tasks = inst.tasks.filter((x) => x.node_index === idx)
        const cc = tasks.filter((x) => x.kind === 'cc')
        const approvers = tasks.filter(
          (x) => x.kind === 'approve' && x.approver
        )
        const skipped = tasks.find(
          (x) => x.kind === 'approve' && !x.approver && x.action === 'skipped'
        )
        const active = idx === inst.current_node && inst.status === 'pending'
        const label = t('card.node', { index: idx + 1 })

        if (cc.length > 0) {
          return (
            <li key={idx} className={chainRow(false)}>
              {label} · {t('card.cc')}:
              {cc.map((x) => x.approver?.full_name || '—').join('、')}
            </li>
          )
        }
        if (skipped) {
          return (
            <li key={idx} className={chainRow(false)}>
              {label}:{t('card.skipped')}
            </li>
          )
        }
        if (approvers.length <= 1) {
          const task = approvers[0] ?? tasks[0]
          return (
            <li key={idx} className={chainRow(active)}>
              {label}：{task?.approver?.full_name || t('card.unassigned')}
              {task &&
                task.action !== 'pending' &&
                ` · ${t(`status.${task.action}`)}`}
              {task?.comment && ` · ${task.comment}`}
            </li>
          )
        }
        const done = approvers.filter((x) => x.action === 'approved').length
        return (
          <li key={idx} className={chainRow(active)}>
            <span className={css({ fontWeight: 500 })}>
              {label} ·{' '}
              {modeOf(idx) === 'or'
                ? t('card.countersignOr')
                : t('card.countersignAnd')}{' '}
              · {t('card.progress', { done, total: approvers.length })}
            </span>
            <ul
              className={css({
                listStyle: 'none',
                margin: '0.125rem 0 0',
                padding: '0 0 0 0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.125rem',
              })}
            >
              {approvers.map((x) => (
                <li key={x.approver?.id ?? x.node_index}>
                  {x.approver?.full_name}
                  {x.action !== 'pending' && ` · ${t(`status.${x.action}`)}`}
                  {x.comment && ` · ${x.comment}`}
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

const InstanceCard = ({
  inst,
  fmt,
  mode,
  onAct,
  onCancel,
  onUrge,
}: {
  inst: ApprovalInstance
  fmt: (iso: string) => string
  mode: 'pending' | 'mine'
  onAct: (id: string, action: 'approved' | 'rejected', comment: string) => void
  onCancel: (id: string) => void
  onUrge: (id: string) => void
}) => {
  const { t } = useTranslation('approval')
  const [comment, setComment] = useState('')
  const badgeCls = STATUS_CLS[inst.status] ?? STATUS_CLS.pending

  return (
    <div
      data-testid={`approval-${inst.id}`}
      className={css({
        border: '1px solid token(colors.greyscale.200)',
        borderRadius: '0.75rem',
        padding: '0.875rem 1rem',
        backgroundColor: 'greyscale.000',
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
        <span className={badgeCls}>{t(`status.${inst.status}`)}</span>
      </div>
      <div
        className={css({
          fontSize: '0.75rem',
          color: 'greyscale.500',
          marginTop: '0.25rem',
        })}
      >
        {t('card.applicant')}: {inst.applicant?.full_name || '—'} ·{' '}
        {fmt(inst.created_at)}
      </div>

      {/* needs_assignment：审批人解析失败,给出可操作的引导(否则用户只看到红标一脸问号)。 */}
      {inst.status === 'needs_assignment' && (
        <div
          className={css({
            marginTop: '0.5rem',
            padding: '0.5rem 0.625rem',
            borderRadius: '0.5rem',
            backgroundColor: 'danger.subtle',
            border: '1px solid token(colors.danger.subtle-border)',
            color: 'danger.subtle-text',
            fontSize: '0.75rem',
            lineHeight: 1.5,
          })}
        >
          {t('card.needsAssignmentHint')}
        </div>
      )}

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

      {/* approver chain — grouped by node (P5b: 会签/跳过/抄送) */}
      <NodeChain inst={inst} />

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
            <Button
              variant="primary"
              size="dense"
              onPress={() => onAct(inst.id, 'approved', comment)}
              data-testid={`approval-approve-${inst.id}`}
            >
              {t('act.approve')}
            </Button>
            <Button
              variant="secondary"
              size="dense"
              onPress={() => onAct(inst.id, 'rejected', comment)}
              data-testid={`approval-reject-${inst.id}`}
              className={css({ color: 'danger.600', borderColor: 'danger.300' })}
            >
              {t('act.reject')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'mine' && inst.status === 'pending' && (
        <div
          className={css({
            marginTop: '0.625rem',
            display: 'flex',
            gap: '0.5rem',
          })}
        >
          <Button
            variant="secondary"
            size="dense"
            onPress={() => onUrge(inst.id)}
            data-testid={`approval-urge-${inst.id}`}
          >
            {t('act.urge')}
          </Button>
          <Button
            variant="secondary"
            size="dense"
            onPress={() => onCancel(inst.id)}
            className={css({ color: 'greyscale.700', borderColor: 'greyscale.300' })}
          >
            {t('act.cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
