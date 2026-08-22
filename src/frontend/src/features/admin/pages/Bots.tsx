import { SelectCompat } from '@/primitives/SelectCompat'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { useConfirm } from '@/components/ConfirmProvider'
import { botColorAt } from '@/components/bot/botPalette'
import { useHasPermission } from '@/hooks/useOrgContext'

import {
  type AdminBot,
  disableAdminBot,
  enableAdminBot,
  fetchAdminBots,
} from '../api/adminBots'
import { BotCredentialDialog } from '../components/BotCredentialDialog'

const formatTime = (iso: string | null, locale: string) => {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export const AdminBots = () => {
  const { t, i18n } = useTranslation('admin')
  const qc = useQueryClient()
  const { confirm, alert: showAlert } = useConfirm()
  const has = useHasPermission()

  const [kind, setKind] = useState<'' | 'custom' | 'builtin'>('')
  const [active, setActive] = useState<'' | '1' | '0'>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [credentialFor, setCredentialFor] = useState<AdminBot | null>(null)

  const params = { kind, active, q, page }
  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'bots', params],
    queryFn: () => fetchAdminBots(params),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  const bots = data?.results ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'bots'] })
  const onError = (e: unknown) =>
    void showAlert({
      message: t('bots.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

  const toggle = useMutation({
    mutationFn: ({ bot, reason }: { bot: AdminBot; reason: string }) =>
      bot.is_active ? disableAdminBot(bot.id, reason) : enableAdminBot(bot.id),
    onSuccess: () => void refresh(),
    onError,
  })

  const resetPageThen = (fn: () => void) => {
    fn()
    setPage(1)
  }

  const onToggle = async (bot: AdminBot) => {
    if (bot.is_active) {
      const ok = await confirm({
        message: t('bots.disableConfirm', { name: bot.name }),
      })
      if (!ok) return
    }
    toggle.mutate({ bot, reason: '' })
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      })}
    >
      <div
        className={css({
          flexShrink: 0,
          paddingX: '1.25rem',
          paddingY: '0.875rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h1
          className={css({
            fontSize: '1.125rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
            marginBottom: '0.25rem',
          })}
        >
          {t('bots.title')}
        </h1>
        <p
          className={css({
            fontSize: '0.8125rem',
            color: 'greyscale.500',
            marginBottom: '0.75rem',
          })}
        >
          {t('bots.subtitle')}
        </p>
        <div
          className={css({
            display: 'flex',
            gap: '0.625rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          })}
        >
          <input
            value={q}
            placeholder={t('bots.searchPlaceholder')}
            onChange={(e) => resetPageThen(() => setQ(e.target.value))}
            className={filterControl}
            data-testid="admin-bots-search"
          />
          <SelectCompat
            value={kind}
            onChange={(e) =>
              resetPageThen(() => setKind(e.target.value as typeof kind))
            }
            className={`${filterControl} ${selectChrome}`}
          >
            {/* 缺省只列自定义机器人 —— 内置助手是(助手 × 会话)的积。 */}
            <option value="">{t('bots.filterCustom')}</option>
            <option value="builtin">{t('bots.filterBuiltin')}</option>
            <option value="custom">{t('bots.filterCustomOnly')}</option>
          </SelectCompat>
          <SelectCompat
            value={active}
            onChange={(e) =>
              resetPageThen(() => setActive(e.target.value as typeof active))
            }
            className={`${filterControl} ${selectChrome}`}
          >
            <option value="">{t('bots.filterAllStates')}</option>
            <option value="1">{t('bots.filterActive')}</option>
            <option value="0">{t('bots.filterDisabled')}</option>
          </SelectCompat>
        </div>
      </div>

      <div className={css({ flex: 1, overflowY: 'auto' })}>
        {isFetching && bots.length === 0 ? (
          <p className={emptyText}>{t('bots.loading')}</p>
        ) : bots.length === 0 ? (
          <p className={emptyText}>{t('bots.empty')}</p>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('bots.colBot')}</th>
                <th className={thCls}>{t('bots.colGroup')}</th>
                <th className={thCls}>{t('bots.colCreatedBy')}</th>
                <th className={thCls}>{t('bots.colMessages')}</th>
                <th className={thCls}>{t('bots.colLastUsed')}</th>
                <th className={actionHeadCls}>{t('bots.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr key={bot.id} className={trCls}>
                  <td className={tdCls}>
                    <div
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      })}
                    >
                      <span
                        aria-hidden
                        className={css({
                          width: '0.5rem',
                          height: '0.5rem',
                          borderRadius: '50%',
                          flexShrink: 0,
                        })}
                        style={{
                          backgroundColor: botColorAt(bot.avatar_color_index),
                        }}
                      />
                      <span>{bot.name}</span>
                      {bot.kind === 'builtin' && (
                        <span className={chipCls}>{t('bots.builtinChip')}</span>
                      )}
                      {!bot.is_active && (
                        <span className={chipCls}>
                          {t('bots.disabledChip')}
                        </span>
                      )}
                      {bot.has_callback && (
                        <span className={chipCls}>
                          {t('bots.callbackChip')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={tdCls}>
                    <div>{bot.conversation_name || t('bots.unnamedGroup')}</div>
                    {/* cid 前 12 位:群名可能为空(jusi 没有 admin 读接口),
                        运营拿这串能去 IM 侧对上。 */}
                    <div
                      className={css({
                        fontSize: '0.75rem',
                        color: 'greyscale.400',
                        fontFamily: 'mono',
                      })}
                    >
                      {bot.cid.slice(0, 12)}
                    </div>
                  </td>
                  <td className={tdCls}>{bot.created_by_name || '—'}</td>
                  <td className={tdCls}>{bot.message_count}</td>
                  <td
                    className={`${tdCls} ${css({ whiteSpace: 'nowrap', color: 'greyscale.600' })}`}
                  >
                    {formatTime(bot.last_used_at, i18n.language)}
                  </td>
                  <td className={actionCellCls}>
                    {has('org.bot.secret.read') && bot.kind === 'custom' && (
                      <Button
                        variant="tertiary"
                        size="sm"
                        onPress={() => setCredentialFor(bot)}
                      >
                        {t('bots.viewCredential')}
                      </Button>
                    )}
                    {has('org.bot.write') && (
                      <Button
                        variant="tertiary"
                        size="sm"
                        isDisabled={toggle.isPending}
                        onPress={() => void onToggle(bot)}
                      >
                        {bot.is_active ? t('bots.disable') : t('bots.enable')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        className={css({
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.5rem',
          paddingX: '1.25rem',
          paddingY: '0.625rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!data?.previous}
          onPress={() => setPage((p) => Math.max(1, p - 1))}
        >
          {t('bots.prev')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!data?.next}
          onPress={() => setPage((p) => p + 1)}
        >
          {t('bots.next')}
        </Button>
      </div>

      {credentialFor && (
        <BotCredentialDialog
          botId={credentialFor.id}
          botName={credentialFor.name}
          onClose={() => setCredentialFor(null)}
        />
      )}
    </div>
  )
}

const filterControl = css({
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '4px',
  fontSize: '0.875rem',
  backgroundColor: 'greyscale.000',
})
const tableCls = css({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
})
const theadRowCls = css({
  textAlign: 'left',
  color: 'greyscale.500',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const thBase = {
  paddingX: '1rem',
  paddingY: '0.625rem',
  fontWeight: '600' as const,
}
const thCls = css(thBase)
/* 固定窄列会把中文按钮挤成竖排,让内容说了算(与 Invites 同款)。 */
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
const chipCls = css({
  fontSize: '0.6875rem',
  paddingX: '0.375rem',
  paddingY: '0.0625rem',
  borderRadius: '0.25rem',
  color: 'greyscale.600',
  backgroundColor: 'greyscale.100',
  whiteSpace: 'nowrap',
})
const emptyText = css({
  padding: '2rem',
  textAlign: 'center',
  color: 'greyscale.500',
})
