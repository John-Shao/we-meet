import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RiCheckLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button, IconButton } from '@/primitives'
import { Dialog } from '@/primitives/Dialog'
import { StateHint } from '@/components/StateHint'
import { useCopy } from '@/hooks/useCopy'

import { fetchAdminBotCredential } from '../api/adminBots'

/**
 * 一个机器人的 webhook 地址 + 签名密钥,点开才取。
 *
 * 形状照抄 `features/im/components/bots/BotSecretField.tsx`(懒取 + `gcTime: 0`
 * + 关掉时 `removeQueries`),但**不 import 它** —— admin 是独立的 lazy chunk,
 * 从 `features/im` import 过去会把整条 IM 依赖拖进管理台的包。这份重复是刻意
 * 的;两边唯一共用的模块是零依赖的 `botPalette.ts`。
 *
 * 服务端每次读记一条 `surface=admin` 审计 + 30/hour 限流。**所以这个组件绝不
 * 预取** —— 必须是用户点了「查看凭据」才发请求,否则列表渲染一次就是一批审计
 * 行和一批活凭证。
 *
 * 壳子用共享的 `Modal`(Escape、焦点陷阱、关闭后焦点归位都在里面),不自己
 * 搭一个 `position: fixed` 的遮罩 —— 手搭的那版这三样一个都没有。
 */
export const BotCredentialDialog = ({
  botId,
  botName,
  onClose,
}: {
  botId: string
  botName: string
  onClose: () => void
}) => {
  const { t } = useTranslation('admin')
  const [revealed, setRevealed] = useState(false)
  const { copied, copy } = useCopy()
  const qc = useQueryClient()

  const queryKey = ['admin', 'bot-credential', botId]
  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchAdminBotCredential(botId),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  const close = () => {
    // 关窗即从缓存里抹掉 —— 凭据没有理由在关闭之后还留在内存里。
    qc.removeQueries({ queryKey })
    onClose()
  }

  return (
    <Dialog
      isOpen
      type="flex"
      title={t('bots.credential.title', { name: botName })}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <div className={contentCls}>
        {isPending ? (
          <StateHint className={stateCls} state="loading">
            {t('bots.credential.loading')}
          </StateHint>
        ) : isError ? (
          <StateHint
            className={stateCls}
            state="error"
            action={
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void refetch()}
              >
                {t('feedback.retry')}
              </Button>
            }
          >
            {t('bots.credential.failed')}
          </StateHint>
        ) : (
          <>
            <div className={labelCls}>{t('bots.credential.webhook')}</div>
            <div className={boxCls} data-testid="admin-bot-webhook">
              {data.webhook_url || t('bots.credential.noWebhook')}
            </div>
            {!!data.webhook_url && (
              <Button
                variant="secondary"
                size="sm"
                icon={
                  copied === 'url' ? (
                    <RiCheckLine size={15} />
                  ) : (
                    <RiFileCopyLine size={15} />
                  )
                }
                onPress={() => void copy('url', data.webhook_url)}
              >
                {t('bots.credential.copy')}
              </Button>
            )}

            <div className={css({ marginTop: '1rem' })}>
              <div className={labelCls}>{t('bots.credential.secret')}</div>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                })}
              >
                <code className={boxCls} data-testid="admin-bot-secret">
                  {revealed && data.signing_secret
                    ? data.signing_secret
                    : '••••••••••••'}
                </code>
                <IconButton
                  label={t(
                    revealed ? 'bots.credential.hide' : 'bots.credential.show'
                  )}
                  size="icon28"
                  className={credentialIconCls}
                  onPress={() => setRevealed((v) => !v)}
                >
                  {revealed ? (
                    <RiEyeOffLine size={16} aria-hidden="true" />
                  ) : (
                    <RiEyeLine size={16} aria-hidden="true" />
                  )}
                </IconButton>
                <IconButton
                  label={t('bots.credential.copy')}
                  size="icon28"
                  className={credentialIconCls}
                  isDisabled={!data.signing_secret}
                  onPress={() =>
                    data.signing_secret &&
                    void copy('secret', data.signing_secret)
                  }
                >
                  {copied === 'secret' ? (
                    <RiCheckLine size={16} aria-hidden="true" />
                  ) : (
                    <RiFileCopyLine size={16} aria-hidden="true" />
                  )}
                </IconButton>
              </div>
              {!data.sign_verify_enabled && (
                <p className={hintCls}>{t('bots.credential.signOff')}</p>
              )}
            </div>

            <p className={hintCls}>{t('bots.credential.auditNote')}</p>
          </>
        )}
      </div>
    </Dialog>
  )
}

const contentCls = css({ width: 'min(28rem, calc(100vw - 6rem))' })
const stateCls = css({ padding: 'lg' })

const labelCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  marginBottom: '0.375rem',
})

const boxCls = css({
  flex: 1,
  minWidth: 0,
  wordBreak: 'break-all',
  padding: '0.5rem',
  borderRadius: 'field',
  backgroundColor: 'surface.canvas',
  border: '1px solid token(colors.border.default)',
  fontFamily: 'mono',
  fontSize: '0.75rem',
  color: 'greyscale.800',
  marginBottom: '0.5rem',
})

const hintCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  marginTop: '0.5rem',
  lineHeight: 1.5,
})

const credentialIconCls = css({ marginBottom: 'sm' })
