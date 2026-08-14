import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoute } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useUser } from '@/features/auth'
import { authUrl } from '@/features/auth/utils/authUrl'

import {
  type MyJoinRequest,
  applyToInvite,
  cancelJoinRequest,
  fetchInviteInfo,
  fetchMyJoinRequests,
} from './api/invite'

/**
 * 邀请落地页 `/invite/:code` —— M4 唯一新增的 C 端表面,且必须匿名可开。
 *
 * 四态:
 *   1. 未登录 —— 显示「X 公司邀请你加入 Y 部门」+ 登录并加入
 *   2. 已登录未申请 —— 申请加入
 *   3. 已申请 —— 显示进度,可撤回
 *   4. 已驳回 —— 显示管理员填写的原因,可重新申请
 *
 * 链接无效/过期/停用/用尽在这里**长得一模一样**,因为后端就返回同一个东西:
 * 能区分出「存在但过期」就能拿它枚举邀请码。
 */
export const InviteRoute = () => {
  const { t } = useTranslation('invite')
  const [, params] = useRoute('/invite/:code')
  const code = params?.code ?? ''
  const { isLoggedIn } = useUser()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const { data: info, isLoading } = useQuery({
    queryKey: ['invite', code],
    queryFn: () => fetchInviteInfo(code),
    enabled: code !== '',
    retry: false,
  })

  const { data: mine = [], isLoading: isMineLoading } = useQuery({
    queryKey: ['invite', 'mine', code],
    queryFn: () => fetchMyJoinRequests(code),
    enabled: isLoggedIn === true,
    staleTime: 10_000,
  })
  // The API returns newest first. A user can be rejected, reapply, and receive
  // another decision, so an older approved/rejected row must never mask the
  // latest application.
  const currentRequest: MyJoinRequest | undefined = mine[0]
  const pending =
    currentRequest?.status === 'pending' ? currentRequest : undefined
  const approved =
    currentRequest?.status === 'approved' ? currentRequest : undefined
  const rejected =
    currentRequest?.status === 'rejected' ? currentRequest : undefined

  const applyMut = useMutation({
    mutationFn: () => applyToInvite(code),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['invite', 'mine', code] }),
    onError: () => setError(t('applyFailed')),
  })
  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelJoinRequest(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['invite', 'mine', code] }),
  })

  // 登录跳转带 returnTo,回来还停在这一页 —— 否则人被丢回工作台,手上那条
  // 链接就白点了。
  useEffect(() => {
    setError(null)
  }, [code])

  if (isLoading || isLoggedIn === undefined || (isLoggedIn && isMineLoading)) {
    return <div className={shellCls} />
  }

  if (!info?.valid) {
    return (
      <div className={shellCls}>
        <div className={cardCls}>
          <h1 className={titleCls}>{t('invalidTitle')}</h1>
          <p className={bodyCls}>{t('invalidBody')}</p>
        </div>
      </div>
    )
  }

  const where = info.department_name
    ? t('joinDepartment', {
        organization: info.organization_name,
        department: info.department_name,
      })
    : t('joinOrganization', { organization: info.organization_name })

  return (
    <div className={shellCls}>
      <div className={cardCls}>
        <h1 className={titleCls}>{where}</h1>

        {approved ? (
          <>
            <p className={bodyCls}>{t('approvedBody')}</p>
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                window.location.href = '/im'
              }}
            >
              {t('openWorkspace')}
            </Button>
          </>
        ) : pending ? (
          <>
            <p className={bodyCls}>{t('pendingBody')}</p>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={cancelMut.isPending}
              onPress={() => cancelMut.mutate(pending.id)}
            >
              {t('withdraw')}
            </Button>
          </>
        ) : rejected ? (
          <>
            <p className={bodyCls}>{t('rejectedBody')}</p>
            {rejected.reject_reason && (
              <div className={reasonCls}>
                <span className={reasonLabelCls}>{t('rejectionReason')}</span>
                <p className={reasonTextCls}>{rejected.reject_reason}</p>
              </div>
            )}
            <Button
              variant="primary"
              size="sm"
              isDisabled={applyMut.isPending}
              loading={applyMut.isPending}
              onPress={() => applyMut.mutate()}
            >
              {t('reapply')}
            </Button>
          </>
        ) : isLoggedIn ? (
          <>
            <p className={bodyCls}>
              {info.require_approval ? t('needsApproval') : t('noApproval')}
            </p>
            <Button
              variant="primary"
              size="sm"
              isDisabled={applyMut.isPending}
              loading={applyMut.isPending}
              onPress={() => applyMut.mutate()}
            >
              {t('apply')}
            </Button>
          </>
        ) : (
          <>
            <p className={bodyCls}>{t('signInHint')}</p>
            {/* 与 LoginButton 同款:整站的登录入口都是把 location 换掉,
                而不是渲染成 <a> —— OIDC 那一跳不该被路由器接管。 */}
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                window.location.href = authUrl({
                  returnTo: window.location.href,
                })
              }}
            >
              {t('signInAndJoin')}
            </Button>
          </>
        )}

        {error && <p className={errorCls}>{error}</p>}
      </div>
    </div>
  )
}

const shellCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '60vh',
  padding: '1.5rem',
})
const cardCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  maxWidth: '28rem',
  width: '100%',
  textAlign: 'center',
  padding: '2rem 1.5rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '12px',
  backgroundColor: 'greyscale.000',
})
const titleCls = css({
  fontSize: '1.25rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
  lineHeight: 1.4,
})
const bodyCls = css({
  fontSize: '0.9375rem',
  color: 'greyscale.600',
  margin: 0,
})
const reasonCls = css({
  width: '100%',
  padding: '0.75rem 1rem',
  textAlign: 'left',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
})
const reasonLabelCls = css({
  display: 'block',
  marginBottom: '0.25rem',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
const reasonTextCls = css({
  margin: 0,
  fontSize: '0.9375rem',
  color: 'greyscale.800',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const errorCls = css({
  fontSize: '0.875rem',
  color: 'danger.subtle-text',
  margin: 0,
})
