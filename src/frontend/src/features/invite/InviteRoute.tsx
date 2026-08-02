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
 * 三态:
 *   1. 未登录 —— 显示「X 公司邀请你加入 Y 部门」+ 登录并加入
 *   2. 已登录未申请 —— 申请加入
 *   3. 已申请 —— 显示进度,可撤回
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

  const { data: mine = [] } = useQuery({
    queryKey: ['invite', 'mine'],
    queryFn: fetchMyJoinRequests,
    enabled: isLoggedIn === true,
    staleTime: 10_000,
  })
  const pending: MyJoinRequest | undefined = mine.find((r) => r.status === 'pending')
  const approved: MyJoinRequest | undefined = mine.find((r) => r.status === 'approved')

  const applyMut = useMutation({
    mutationFn: () => applyToInvite(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invite', 'mine'] }),
    onError: () => setError(t('applyFailed')),
  })
  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelJoinRequest(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invite', 'mine'] }),
  })

  // 登录跳转带 returnTo,回来还停在这一页 —— 否则人被丢回工作台,手上那条
  // 链接就白点了。
  useEffect(() => {
    setError(null)
  }, [code])

  if (isLoading || isLoggedIn === undefined) {
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
                window.location.href = authUrl({ returnTo: window.location.href })
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
const bodyCls = css({ fontSize: '0.9375rem', color: 'greyscale.600', margin: 0 })
const errorCls = css({ fontSize: '0.875rem', color: 'danger.subtle-text', margin: 0 })
