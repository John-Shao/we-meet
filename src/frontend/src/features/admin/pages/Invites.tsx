import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { RiAddLine, RiCheckLine, RiFileCopyLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type InviteLink,
  type JoinRequest,
  approveJoinRequest,
  createInviteLink,
  fetchInviteLinks,
  fetchJoinRequests,
  formatInviteCode,
  inviteUrl,
  rejectJoinRequest,
  revokeInviteLink,
} from '../api/adminInviteLinks'
import { fetchAdminDepartments } from '../api/adminDepartments'
import { describeApiError } from '../api/errors'
import { InviteLinkDialog } from '../components/InviteLinkDialog'
import { RejectJoinRequestDialog } from '../components/RejectJoinRequestDialog'

const LINKS_KEY = ['admin', 'invite-links']
const REQUESTS_KEY = ['admin', 'join-requests']

/**
 * 「邀请成员」—— 发一份**不指向具体人**的凭证,谁拿到谁申请。
 *
 * 与「添加成员」的差别不是界面,是谁指定了人:添加是管理员指名道姓填手机号,
 * 所以不需要审批(他已经决定了);邀请是把门开一条缝,所以必须有有效期、
 * 用量上限和审批。两个列表刻意分开——「待接受邀请」是我们推出去的,
 * 「申请列表」是别人拉进来的,操作集完全不同。
 *
 * ⚠️ 页面顶部那条提示不是客套话:当前组织开着自动加入,任何能登录的人已经
 * 是成员了,所以这里的审批决定的是**部门与角色**,不是准入。见
 * docs/phases/p10b-invitation-system.md §三。
 */
export const AdminInvites = () => {
  const { t } = useTranslation('admin')
  const { confirm, alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()

  const [creating, setCreating] = useState(false)
  const [rejectTarget, setRejectTarget] = useState<JoinRequest | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('pending')

  const { data: linkPage } = useQuery({
    queryKey: LINKS_KEY,
    queryFn: () => fetchInviteLinks(true),
    staleTime: 30_000,
  })
  const links = linkPage?.results ?? []
  const current = links[0] ?? null

  const { data: requestPage, isFetching } = useQuery({
    queryKey: [...REQUESTS_KEY, statusFilter],
    queryFn: () => fetchJoinRequests(statusFilter),
    staleTime: 15_000,
  })
  const requests = requestPage?.results ?? []

  const { data: departments = [] } = useQuery({
    queryKey: ['admin', 'departments'],
    queryFn: () => fetchAdminDepartments(),
    staleTime: 60_000,
  })

  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: LINKS_KEY })
    queryClient.invalidateQueries({ queryKey: REQUESTS_KEY })
  }

  const createMut = useMutation({
    mutationFn: createInviteLink,
    onSuccess: () => {
      invalidate()
      setCreating(false)
    },
    onError,
  })
  const revokeMut = useMutation({
    mutationFn: revokeInviteLink,
    onSuccess: invalidate,
    onError,
  })
  const approveMut = useMutation({
    mutationFn: (id: string) => approveJoinRequest(id),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['admin', 'members'] })
    },
    onError,
  })
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectJoinRequest(id, reason),
    onSuccess: () => {
      invalidate()
      setRejectTarget(null)
    },
    onError,
  })

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600)
    } catch {
      // 剪贴板在非 https / 无权限时会拒绝。与其静默失败,不如把内容摊开
      // 让人自己选中复制。
      showAlert({ message: value })
    }
  }

  const revoke = async (link: InviteLink) => {
    const ok = await confirm({
      message: t('invites.revokeConfirm', { code: formatInviteCode(link.code) }),
      danger: true,
    })
    if (ok) revokeMut.mutate(link.id)
  }

  const url = current ? inviteUrl(current.code) : ''

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', height: '100%' })}>
      <div className={headerCls}>
        <h1 className={titleCls}>{t('invites.title')}</h1>
        <Button size="sm" variant="primary" icon={<RiAddLine size={16} />} onPress={() => setCreating(true)}>
          {t('invites.newLink')}
        </Button>
      </div>

      <div className={css({ flex: 1, overflowY: 'auto', paddingX: '1.25rem', paddingY: '1rem' })}>
        {/* 说清楚这个审批今天到底管什么。管理员以为自己在把门、实际没有,
            比没有审批更糟。 */}
        <p className={noticeCls}>{t('invites.autoJoinNotice')}</p>

        <h2 className={sectionCls}>{t('invites.methods')}</h2>
        {current === null ? (
          <p className={emptyCls}>{t('invites.noLink')}</p>
        ) : (
          <>
            <dl className={configCls}>
              <div>
                <dt>{t('invites.configDepartment')}</dt>
                <dd>{current.department?.name ?? t('members.orgLevel')}</dd>
              </div>
              <div>
                <dt>{t('invites.configApproval')}</dt>
                <dd>
                  {current.require_approval
                    ? t('invites.approvalRequired')
                    : t('invites.approvalOpen')}
                </dd>
              </div>
              <div>
                <dt>{t('invites.configExpiry')}</dt>
                <dd>{new Date(current.expires_at).toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t('invites.configUses')}</dt>
                <dd>
                  {current.max_uses === null
                    ? t('invites.usesUnlimited', { used: current.used_count })
                    : `${current.used_count} / ${current.max_uses}`}
                </dd>
              </div>
            </dl>

            {/* 三张卡读的是同一个 code:邀请码是链接的末段,二维码是链接的渲染。 */}
            <div className={cardsCls}>
              <section className={cardCls}>
                <h3 className={cardTitleCls}>{t('invites.cardCode')}</h3>
                <p className={cardHintCls}>{t('invites.cardCodeHint')}</p>
                <div className={codeBoxCls}>{formatInviteCode(current.code)}</div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={copied === 'code' ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
                  onPress={() => copy('code', current.code)}
                >
                  {copied === 'code' ? t('invites.copied') : t('invites.copyCode')}
                </Button>
              </section>

              <section className={cardCls}>
                <h3 className={cardTitleCls}>{t('invites.cardLink')}</h3>
                <p className={cardHintCls}>{t('invites.cardLinkHint')}</p>
                <div className={linkBoxCls}>{url}</div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={copied === 'url' ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
                  onPress={() => copy('url', url)}
                >
                  {copied === 'url' ? t('invites.copied') : t('invites.copyLink')}
                </Button>
              </section>

              <section className={cardCls}>
                <h3 className={cardTitleCls}>{t('invites.cardQr')}</h3>
                <p className={cardHintCls}>{t('invites.cardQrHint')}</p>
                <div className={qrBoxCls}>
                  <QRCodeSVG value={url} size={132} level="M" />
                </div>
                <Button variant="secondary" size="sm" onPress={() => revoke(current)}>
                  {t('invites.revoke')}
                </Button>
              </section>
            </div>
          </>
        )}

        <h2 className={sectionCls}>{t('invites.requests')}</h2>
        <div className={css({ marginBottom: '0.75rem' })}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={selectCls}
          >
            {['pending', 'approved', 'rejected', 'expired'].map((s) => (
              <option key={s} value={s}>
                {t(`invites.status.${s}`)}
              </option>
            ))}
          </select>
        </div>

        {requests.length === 0 ? (
          <p className={emptyCls}>{isFetching ? '' : t('invites.noRequests')}</p>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('invites.colApplicant')}</th>
                <th className={thCls}>{t('invites.colPhone')}</th>
                <th className={thCls}>{t('members.colDepartment')}</th>
                <th className={thCls}>{t('invites.colInviter')}</th>
                <th className={thCls}>{t('members.colStatus')}</th>
                <th className={thCls}>{t('invites.colReviewer')}</th>
                <th className={actionHeadCls} />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className={trCls}>
                  <td className={tdCls}>{r.full_name || '—'}</td>
                  <td className={tdCls}>{r.phone || '—'}</td>
                  <td className={tdCls}>
                    {r.department?.name ?? t('members.orgLevel')}
                  </td>
                  <td className={tdCls}>
                    {r.invited_by?.full_name || r.invited_by?.short_name || '—'}
                  </td>
                  <td className={tdCls}>{t(`invites.status.${r.status}`)}</td>
                  <td className={tdCls}>
                    {r.reviewed_by?.full_name || r.reviewed_by?.short_name || '—'}
                  </td>
                  <td className={actionCellCls}>
                    {r.status === 'pending' && (
                      <span className={css({ display: 'inline-flex', gap: '0.375rem' })}>
                        <Button
                          variant="secondary"
                          size="dense"
                          isDisabled={approveMut.isPending}
                          onPress={() => approveMut.mutate(r.id)}
                        >
                          {t('invites.approve')}
                        </Button>
                        <Button
                          variant="secondaryText"
                          size="dense"
                          onPress={() => setRejectTarget(r)}
                        >
                          {t('invites.reject')}
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <InviteLinkDialog
        isOpen={creating}
        departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        submitting={createMut.isPending}
        onSubmit={(input) => createMut.mutate(input)}
        onClose={() => setCreating(false)}
      />
      <RejectJoinRequestDialog
        request={rejectTarget}
        submitting={rejectMut.isPending}
        onSubmit={(reason) =>
          rejectTarget && rejectMut.mutate({ id: rejectTarget.id, reason })
        }
        onClose={() => setRejectTarget(null)}
      />
    </div>
  )
}

const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({ fontSize: '1.125rem', fontWeight: 'bold', color: 'greyscale.900' })
const noticeCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  backgroundColor: 'greyscale.100',
  borderRadius: '8px',
  padding: '0.625rem 0.875rem',
  marginBottom: '1rem',
})
const sectionCls = css({
  fontSize: '0.9375rem',
  fontWeight: '600',
  color: 'greyscale.900',
  marginTop: '1.25rem',
  marginBottom: '0.75rem',
})
const emptyCls = css({ color: 'greyscale.500', fontSize: '0.9375rem', paddingY: '1rem' })
const configCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.75rem 1.5rem',
  marginBottom: '1rem',
  fontSize: '0.875rem',
  '& dt': { color: 'greyscale.500', marginBottom: '0.125rem' },
  '& dd': { color: 'greyscale.900', margin: 0 },
})
const cardsCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
  gap: '1rem',
})
const cardCls = css({
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.625rem',
})
const cardTitleCls = css({ fontSize: '0.9375rem', fontWeight: '600', color: 'greyscale.900' })
const cardHintCls = css({ fontSize: '0.75rem', color: 'greyscale.500', margin: 0 })
const codeBoxCls = css({
  fontSize: '1.5rem',
  fontWeight: 'bold',
  letterSpacing: '0.15em',
  color: 'greyscale.900',
  backgroundColor: 'greyscale.100',
  borderRadius: '8px',
  padding: '1.25rem 1rem',
  width: '100%',
  textAlign: 'center',
})
const linkBoxCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  backgroundColor: 'greyscale.100',
  borderRadius: '8px',
  padding: '0.75rem',
  width: '100%',
  wordBreak: 'break-all',
  minHeight: '4.5rem',
})
const qrBoxCls = css({
  backgroundColor: 'greyscale.000',
  padding: '0.5rem',
  borderRadius: '8px',
  lineHeight: 0,
})
const tableCls = css({ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' })
const theadRowCls = css({
  textAlign: 'left',
  color: 'greyscale.500',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const thBase = { paddingX: '1rem', paddingY: '0.625rem', fontWeight: '600' as const }
const thCls = css(thBase)
/* 与「待接受邀请」同款:固定窄列会把中文按钮挤成竖排,让内容说了算。 */
const actionHeadCls = css({ ...thBase, width: '1%', whiteSpace: 'nowrap' })
const actionCellCls = css({
  paddingX: '1rem',
  paddingY: '0.5rem',
  width: '1%',
  whiteSpace: 'nowrap',
  textAlign: 'right',
})
const trCls = css({
  borderBottom: '1px solid token(colors.greyscale.100)',
  _hover: { backgroundColor: 'greyscale.50' },
})
const tdCls = css({
  paddingX: '1rem',
  paddingY: '0.5rem',
  color: 'greyscale.800',
  verticalAlign: 'middle',
})
const selectCls = css({
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
})
