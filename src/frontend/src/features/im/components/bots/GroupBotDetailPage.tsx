import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { ApiError } from '@/api/ApiError'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { useConfirm } from '@/components/ConfirmProvider'
import { useCopy } from '@/hooks/useCopy'
import { useInlineEditFocus } from '@/hooks/useInlineEditFocus'

import { SwitchRow } from '../SettingRows'
import {
  deleteGroupBot,
  listGroupBots,
  resetBotSecret,
  rotateBotCallbackSecret,
  updateGroupBot,
} from '../../api/groupBots'
import { BotAvatar } from './BotAvatar'
import { BotSecretField } from './BotSecretField'
import { CustomBotForm } from './CustomBotForm'
import {
  dangerBtnCls,
  hintCls,
  inputCls,
  linkBoxCls,
  linkBtnCls,
  sectionCls,
  sectionLabelCls,
} from './botStyles'

/**
 * One bot: identity, its webhook address, the three security gates, removal.
 *
 * Read out of the list cache rather than a detail endpoint — the list is
 * already loaded when you get here, and one less endpoint is one less thing to
 * invalidate.
 */
export const GroupBotDetailPage = ({
  cid,
  botId,
  onRemoved,
}: {
  cid: string
  botId: string
  onRemoved: () => void
}) => {
  const { t } = useTranslation('im')
  const qc = useQueryClient()
  const { confirm, alert: showAlert } = useConfirm()
  const { copied, copy } = useCopy()
  const [editing, setEditing] = useState(false)
  const [ipDraft, setIpDraft] = useState<string | null>(null)
  const [keywordDraft, setKeywordDraft] = useState('')
  const [callbackDraft, setCallbackDraft] = useState<string | null>(null)
  // 只取 triggerRef:编辑表单里的第一个字段由 CustomBotForm 自己聚焦(它是弹窗的
  // 第二页,Modal 的 initialFocusRef 只在挂载时触发一次),这里要补的是**退出**那一半
  // —— 取消/保存后编辑表单卸载,焦点会掉到 <body>,应还给「编辑」按钮。
  const { triggerRef: editTriggerRef } = useInlineEditFocus(editing)

  const { data: bots = [], isLoading } = useQuery({
    queryKey: ['im', 'bots', cid],
    queryFn: () => listGroupBots(cid),
    staleTime: 30_000,
    retry: false,
  })
  const bot = bots.find((b) => b.id === botId)

  /**
   * `ApiError.message` 恒等于 `"Api error <code>"`,有用的正文在 `.body` 里。
   * 直接用 `e.message` 的话群主只会看到「操作失败:Api error 400」—— 等于没说,
   * 而这个面板每一条校验(关键词、IP 白名单、回调地址)都走这里。
   *
   * 回调地址被拒时后端还会额外带一个机器可读的 `code`(= `outbound_http` 的
   * category),映射成中文;认不出的 code 退回后端原文,不至于变成一句空话。
   */
  const onError = (e: unknown) => {
    const code =
      e instanceof ApiError && !!e.body && typeof e.body === 'object'
        ? (e.body as { code?: unknown }).code
        : undefined
    const message =
      typeof code === 'string' && code
        ? t(`bots.callback.urlError.${code}`, {
            defaultValue: apiErrorMessage(e),
          })
        : apiErrorMessage(e)
    void showAlert({ message: t('bots.error', { message }) })
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ['im', 'bots', cid] })

  const patch = useMutation({
    mutationFn: (args: Parameters<typeof updateGroupBot>[1]) =>
      updateGroupBot(botId, args),
    onSuccess: () => {
      void refresh()
      void qc.invalidateQueries({ queryKey: ['im', 'member-names'] })
      void qc.invalidateQueries({ queryKey: ['im', 'member-names-extra'] })
      setEditing(false)
    },
    onError,
  })

  const remove = useMutation({
    mutationFn: () => deleteGroupBot(botId),
    onSuccess: () => {
      void refresh()
      onRemoved()
    },
    onError,
  })

  const rotate = useMutation({
    mutationFn: () => resetBotSecret(botId),
    onSuccess: (result) => {
      // Show the new value immediately — rotating a credential and not telling
      // the operator what it became is just breaking their integration.
      qc.setQueryData(['im', 'bot-secret', botId], result)
      void showAlert({ message: t('bots.security.resetDone') })
    },
    onError,
  })

  const rotateCallback = useMutation({
    mutationFn: () => rotateBotCallbackSecret(botId),
    onSuccess: (result) => {
      // queryKey 与 BotSecretField 的 `kind` 一致 —— 写错了不会报错,只会让
      // 群主看着旧值以为轮换没生效。
      qc.setQueryData(['im', 'bot-callback-secret', botId], result)
      void showAlert({ message: t('bots.callback.rotateDone') })
    },
    onError,
  })

  if (isLoading)
    return <StateHint state="loading">{t('group.loading')}</StateHint>
  if (!bot) return <StateHint>{t('bots.gone')}</StateHint>

  // Non-owners get null for every credential field; there is nothing to show.
  const canManage = bot.webhook_url !== null || bot.kind === 'builtin'
  const keywords = bot.keywords ?? []

  if (editing)
    return (
      <CustomBotForm
        initial={{
          name: bot.name,
          description: bot.description,
          avatarColorIndex: bot.avatar_color_index,
        }}
        busy={patch.isPending}
        submitLabel={t('bots.form.save')}
        onCancel={() => setEditing(false)}
        onSubmit={(value) =>
          patch.mutate({
            name: value.name,
            description: value.description,
            avatar_color_index: value.avatarColorIndex,
          })
        }
      />
    )

  return (
    <>
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
      >
        <BotAvatar
          name={bot.name}
          src={bot.avatar_url}
          colorIndex={bot.avatar_color_index}
          size="2.75rem"
        />
        <div className={css({ flex: 1, minWidth: 0 })}>
          <div
            className={css({ fontSize: '0.9375rem', color: 'greyscale.900' })}
          >
            {bot.name}
          </div>
          {bot.description && (
            <div
              className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
            >
              {bot.description}
            </div>
          )}
        </div>
        {canManage && bot.kind === 'custom' && (
          <button
            type="button"
            ref={editTriggerRef}
            onClick={() => setEditing(true)}
            className={linkBtnCls}
            data-testid="bot-edit"
          >
            {t('bots.edit')}
          </button>
        )}
      </div>

      {bot.kind === 'builtin' ? (
        <>
          <p className={cx(hintCls, css({ padding: '0.875rem 1rem' }))}>
            {t('bots.builtinHint')}
          </p>
          {canManage && (
            <SwitchRow
              label={t('bots.enabled')}
              checked={bot.is_active}
              onChange={() => patch.mutate({ is_active: !bot.is_active })}
              disabled={patch.isPending}
              testid="bot-enabled-toggle"
            />
          )}
        </>
      ) : !canManage ? (
        <p className={cx(hintCls, css({ padding: '0.875rem 1rem' }))}>
          {t('bots.ownerOnlyHint')}
        </p>
      ) : (
        <>
          <div className={sectionCls}>
            <div className={sectionLabelCls}>{t('bots.webhook.title')}</div>
            <div className={linkBoxCls} data-testid="bot-webhook-url">
              {bot.webhook_url}
            </div>
            <div
              className={css({
                display: 'flex',
                gap: '0.5rem',
                marginTop: '0.5rem',
              })}
            >
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
                onPress={() => void copy('url', bot.webhook_url ?? '')}
              >
                {copied === 'url'
                  ? t('bots.webhook.copied')
                  : t('bots.webhook.copy')}
              </Button>
            </div>
            <p className={hintCls}>{t('bots.webhook.hint')}</p>
          </div>

          <div className={sectionCls}>
            <div className={sectionLabelCls}>{t('bots.security.title')}</div>
            <p className={cx(hintCls, css({ marginTop: 0 }))}>
              {t('bots.security.hint')}
            </p>
          </div>

          <SwitchRow
            label={t('bots.security.sign')}
            checked={!!bot.sign_verify_enabled}
            onChange={() =>
              patch.mutate({ sign_verify_enabled: !bot.sign_verify_enabled })
            }
            disabled={patch.isPending}
            testid="bot-sign-toggle"
          />
          {bot.sign_verify_enabled && (
            <div className={sectionCls}>
              <div className={sectionLabelCls}>{t('bots.security.secret')}</div>
              <BotSecretField botId={botId} />
              <button
                type="button"
                className={cx(linkBtnCls, css({ marginTop: '0.5rem' }))}
                onClick={async () => {
                  const ok = await confirm({
                    message: t('bots.security.resetConfirm'),
                  })
                  if (ok) rotate.mutate()
                }}
              >
                {t('bots.security.reset')}
              </button>
            </div>
          )}

          <div className={sectionCls}>
            <div className={sectionLabelCls}>{t('bots.security.keywords')}</div>
            <div
              className={css({
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.375rem',
                marginBottom: '0.5rem',
              })}
            >
              {keywords.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() =>
                    patch.mutate({
                      keywords: keywords.filter((k) => k !== word),
                    })
                  }
                  className={css({
                    fontSize: '0.75rem',
                    borderRadius: '0.25rem',
                    paddingX: '0.375rem',
                    paddingY: '0.125rem',
                    color: 'greyscale.700',
                    backgroundColor: 'greyscale.100',
                    border: '1px solid token(colors.greyscale.300)',
                    cursor: 'pointer',
                  })}
                >
                  {word} ×
                </button>
              ))}
            </div>
            <input
              value={keywordDraft}
              placeholder={t('bots.security.keywordPlaceholder')}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const word = keywordDraft.trim()
                if (!word || keywords.includes(word)) return
                patch.mutate({ keywords: [...keywords, word] })
                setKeywordDraft('')
              }}
              className={inputCls}
              data-testid="bot-keyword-input"
            />
            <p className={hintCls}>{t('bots.security.keywordsHint')}</p>
          </div>

          <div className={sectionCls}>
            <div className={sectionLabelCls}>
              {t('bots.security.ipAllowlist')}
            </div>
            <textarea
              rows={3}
              value={ipDraft ?? (bot.ip_allowlist ?? []).join('\n')}
              onChange={(e) => setIpDraft(e.target.value)}
              className={cx(inputCls, css({ resize: 'vertical' }))}
              data-testid="bot-ip-allowlist"
            />
            <p className={hintCls}>{t('bots.security.ipAllowlistHint')}</p>
            {ipDraft !== null && (
              <div className={css({ marginTop: '0.5rem' })}>
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={patch.isPending}
                  onPress={() => {
                    patch.mutate({
                      ip_allowlist: ipDraft
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                    })
                    setIpDraft(null)
                  }}
                >
                  {t('bots.security.save')}
                </Button>
              </div>
            )}
          </div>

          {/*
            出站回调 (A3). 地址挂在**机器人**上而不是按钮里 —— 按钮里带 URL
            等于任何拿到 webhook token 的人都能把我们的服务器变成任意 HTTP
            代理。这是整个 SSRF 面上最重要的一刀,别为了「灵活」挪回按钮。
          */}
          <div className={sectionCls}>
            <div className={sectionLabelCls}>{t('bots.callback.title')}</div>
            <input
              value={callbackDraft ?? bot.callback_url ?? ''}
              placeholder={t('bots.callback.urlPlaceholder')}
              onChange={(e) => setCallbackDraft(e.target.value)}
              className={inputCls}
              data-testid="bot-callback-url"
            />
            <p className={hintCls}>{t('bots.callback.hint')}</p>
            {callbackDraft !== null && (
              <div className={css({ marginTop: '0.5rem' })}>
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={patch.isPending}
                  onPress={() => {
                    // 后端写入时就校验地址,失败会走 onError 弹出来 —— 群主
                    // 当场看到报错,而不是配完之后每次点击都静默失败。
                    patch.mutate({ callback_url: callbackDraft.trim() })
                    setCallbackDraft(null)
                  }}
                >
                  {t('bots.callback.save')}
                </Button>
              </div>
            )}
            {bot.callback_enabled === false && (
              <p
                className={css({
                  fontSize: '0.75rem',
                  lineHeight: 1.5,
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: '0.375rem',
                  backgroundColor: 'danger.subtle',
                  color: 'danger.subtle-text',
                })}
                data-testid="bot-callback-disabled"
              >
                {t('bots.callback.disabled')}
              </p>
            )}
            {!!bot.callback_last_error && (
              <p
                className={css({
                  fontSize: '0.75rem',
                  marginTop: '0.375rem',
                  color: 'danger.subtle-text',
                })}
                data-testid="bot-callback-error"
              >
                {t('bots.callback.lastError', {
                  reason: t(`bots.callback.reason.${bot.callback_last_error}`),
                })}
              </p>
            )}
          </div>

          {!!bot.callback_url && (
            <>
              {/*
                没有这个字段,出站签名就只是装饰 —— 接收方拿不到密钥就验不了,
                只能退回「URL 保密」,而那正是签名本来要替换掉的东西。
              */}
              <div className={sectionCls}>
                <div className={sectionLabelCls}>
                  {t('bots.callback.secret')}
                </div>
                <BotSecretField botId={botId} kind="callback" />
                <p className={hintCls}>{t('bots.callback.secretHint')}</p>
                {/*
                  这把密钥原先**只能铸一次**:它在第一次配回调地址时生成,之后
                  没有任何路径能改它。而设计文档写着「轮换 = 断掉外部积累的行为
                  画像」—— 承诺了一个做不到的动作。轮换同时换掉 actor 假名,
                  所以确认文案必须点明,不能只说「旧签名会失效」。
                */}
                <button
                  type="button"
                  className={cx(linkBtnCls, css({ marginTop: '0.5rem' }))}
                  onClick={async () => {
                    const ok = await confirm({
                      message: t('bots.callback.rotateConfirm'),
                    })
                    if (ok) rotateCallback.mutate()
                  }}
                >
                  {t('bots.callback.rotate')}
                </button>
              </div>
              <SwitchRow
                label={t('bots.callback.identity')}
                checked={!!bot.callback_include_identity}
                onChange={() =>
                  patch.mutate({
                    callback_include_identity: !bot.callback_include_identity,
                  })
                }
                disabled={patch.isPending}
                testid="bot-callback-identity-toggle"
              />
              <p className={cx(hintCls, css({ padding: '0 1rem 0.75rem' }))}>
                {t('bots.callback.identityHint')}
              </p>
            </>
          )}

          <div className={css({ padding: '0.875rem 1rem' })}>
            <button
              type="button"
              disabled={remove.isPending}
              data-testid="bot-remove"
              className={dangerBtnCls}
              onClick={async () => {
                const ok = await confirm({
                  message: t('bots.removeConfirm', { name: bot.name }),
                })
                if (ok) remove.mutate()
              }}
            >
              {t('bots.remove')}
            </button>
          </div>
        </>
      )}
    </>
  )
}
