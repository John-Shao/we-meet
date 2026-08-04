import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { useConfirm } from '@/components/ConfirmProvider'
import { useCopy } from '@/hooks/useCopy'

import { Avatar } from '../Avatar'
import { SwitchRow } from '../SettingRows'
import {
  deleteGroupBot,
  listGroupBots,
  resetBotSecret,
  updateGroupBot,
} from '../../api/groupBots'
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

  const { data: bots = [], isLoading } = useQuery({
    queryKey: ['im', 'bots', cid],
    queryFn: () => listGroupBots(cid),
    staleTime: 30_000,
    retry: false,
  })
  const bot = bots.find((b) => b.id === botId)

  const onError = (e: unknown) =>
    void showAlert({
      message: t('bots.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

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

  if (isLoading) return <StateHint loading>{t('group.loading')}</StateHint>
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
        <Avatar name={bot.name} src={bot.avatar_url} size="2.75rem" />
        <div className={css({ flex: 1, minWidth: 0 })}>
          <div
            className={css({ fontSize: '0.9375rem', color: 'greyscale.900' })}
          >
            {bot.name}
          </div>
          {bot.description && (
            <div className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>
              {bot.description}
            </div>
          )}
        </div>
        {canManage && bot.kind === 'custom' && (
          <button
            type="button"
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
                    patch.mutate({ keywords: keywords.filter((k) => k !== word) })
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
