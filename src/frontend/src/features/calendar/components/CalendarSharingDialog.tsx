import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { Button } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'
import { DirectoryMultiPicker } from '@/features/contacts/components/DirectoryMultiPicker'

import {
  deleteCalendarGrant,
  fetchCalendarGrants,
  fetchCalendarSubscriptions,
  fetchMyPersonalCalendar,
  saveCalendarGrant,
  subscribeCalendar,
  unsubscribeCalendar,
  updatePersonalCalendar,
  type CalendarPermission,
} from '../api/personalCalendars'
import { inputCls, labelCls } from './formStyles'

interface Props {
  onClose: () => void
  onChanged: () => void
}

export const CalendarSharingDialog = ({ onClose, onChanged }: Props) => {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [mode, setMode] = useState<'share' | 'subscribe'>('share')
  const [permission, setPermission] = useState<'free_busy' | 'details'>(
    'free_busy'
  )
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: mine } = useQuery({
    queryKey: ['calendar', 'personal', 'mine'],
    queryFn: fetchMyPersonalCalendar,
  })
  const { data: grants = [] } = useQuery({
    queryKey: ['calendar', 'grants'],
    queryFn: fetchCalendarGrants,
  })
  const { data: subscriptions = [] } = useQuery({
    queryKey: ['calendar', 'subscriptions'],
    queryFn: fetchCalendarSubscriptions,
  })

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['calendar', 'personal'] }),
      qc.invalidateQueries({ queryKey: ['calendar', 'grants'] }),
      qc.invalidateQueries({ queryKey: ['calendar', 'subscriptions'] }),
    ])
    onChanged()
  }

  const toggle = (id: string, label: string) =>
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const apply = async () => {
    if (selected.size === 0) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'share') {
        await Promise.all(
          [...selected.keys()].map((id) => saveCalendarGrant(id, permission))
        )
      } else {
        await Promise.all(
          [...selected.keys()].map((id) => subscribeCalendar(id))
        )
      }
      setSelected(new Map())
      await invalidate()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const changeDefault = async (value: CalendarPermission) => {
    if (!mine) return
    setBusy(true)
    setError('')
    try {
      await updatePersonalCalendar(mine.id, value)
      await invalidate()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      await invalidate()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('sharing.title')}
      maxWidth="760px"
      maxHeight="84vh"
    >
      <div className={headerCls}>
        <h2 className={titleCls}>{t('sharing.title')}</h2>
        <ModalCloseButton onClose={onClose} label={t('form.cancel')} />
      </div>
      <div className={bodyCls}>
        <div className={defaultRowCls}>
          <label className={labelCls} htmlFor="calendar-default-access">
            {t('sharing.organizationDefault')}
          </label>
          <select
            id="calendar-default-access"
            value={mine?.organization_default_access ?? 'free_busy'}
            onChange={(event) =>
              void changeDefault(event.target.value as CalendarPermission)
            }
            disabled={!mine || busy}
            className={cx(inputCls, selectChrome)}
          >
            <option value="none">{t('sharing.none')}</option>
            <option value="free_busy">{t('sharing.freeBusy')}</option>
            <option value="details">{t('sharing.details')}</option>
          </select>
        </div>

        <div className={tabsCls}>
          {(['share', 'subscribe'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value)
                setSelected(new Map())
                setError('')
              }}
              className={mode === value ? activeTabCls : tabCls}
            >
              {t(`sharing.${value}`)}
            </button>
          ))}
          {mode === 'share' && (
            <select
              value={permission}
              onChange={(event) =>
                setPermission(event.target.value as 'free_busy' | 'details')
              }
              className={cx(inputCls, selectChrome)}
            >
              <option value="free_busy">{t('sharing.freeBusy')}</option>
              <option value="details">{t('sharing.details')}</option>
            </select>
          )}
        </div>

        <div className={pickerCls}>
          <DirectoryMultiPicker
            selected={selected}
            onToggle={toggle}
            includeExternal
            externalLabel={t('form.externalContact')}
            labels={{
              searchPlaceholder: t('form.searchPlaceholder'),
              selectedTitle: t('form.selected', { count: selected.size }),
              loading: t('form.loading'),
              empty: t('form.noResults'),
              loadMore: t('form.loadMore'),
            }}
          />
        </div>
        {error && <p className={errorCls}>{error}</p>}

        <section className={summaryCls}>
          <h3 className={summaryTitleCls}>{t('sharing.sharedWith')}</h3>
          {grants.length === 0 ? (
            <span className={mutedCls}>{t('sharing.empty')}</span>
          ) : (
            grants.map((grant) => (
              <div key={grant.id} className={summaryRowCls}>
                <span>
                  {grant.grantee.full_name || grant.grantee.short_name}
                  {grant.external ? ` · ${t('form.externalContact')}` : ''}
                </span>
                <span className={mutedCls}>
                  {t(
                    `sharing.${grant.permission === 'details' ? 'details' : 'freeBusy'}`
                  )}
                </span>
                <button
                  type="button"
                  className={removeCls}
                  disabled={busy}
                  onClick={() =>
                    void remove(() => deleteCalendarGrant(grant.id))
                  }
                >
                  {t('sharing.remove')}
                </button>
              </div>
            ))
          )}
          <h3 className={summaryTitleCls}>{t('sharing.subscribed')}</h3>
          {subscriptions.length === 0 ? (
            <span className={mutedCls}>{t('sharing.empty')}</span>
          ) : (
            subscriptions.map((subscription) => (
              <div key={subscription.id} className={summaryRowCls}>
                <span>
                  {subscription.owner.full_name ||
                    subscription.owner.short_name}
                </span>
                <span className={mutedCls}>
                  {t(
                    `sharing.${subscription.permission === 'details' ? 'details' : 'freeBusy'}`
                  )}
                </span>
                <button
                  type="button"
                  className={removeCls}
                  disabled={busy}
                  onClick={() =>
                    void remove(() => unsubscribeCalendar(subscription.id))
                  }
                >
                  {t('sharing.unsubscribe')}
                </button>
              </div>
            ))
          )}
        </section>
      </div>
      <div className={footerCls}>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={() => void apply()}
          isDisabled={busy || selected.size === 0}
        >
          {t(
            mode === 'share' ? 'sharing.shareAction' : 'sharing.subscribeAction'
          )}
        </Button>
      </div>
    </Modal>
  )
}

const headerCls = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({ margin: 0, fontSize: '1rem', fontWeight: 700 })
const bodyCls = css({
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  overflowY: 'auto',
})
const defaultRowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 220px',
  alignItems: 'center',
  gap: '1rem',
})
const tabsCls = css({ display: 'flex', alignItems: 'center', gap: '0.5rem' })
const tabCls = css({
  border: 'none',
  background: 'transparent',
  padding: '0.5rem 0.75rem',
  color: 'greyscale.600',
  cursor: 'pointer',
})
const activeTabCls = css({
  border: 'none',
  borderBottom: '2px solid token(colors.primary.500)',
  background: 'transparent',
  padding: '0.5rem 0.75rem',
  color: 'primary.500',
  cursor: 'pointer',
  _disabled: { color: 'greyscale.400', cursor: 'not-allowed' },
})
const pickerCls = css({
  height: '260px',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  overflow: 'hidden',
})
const errorCls = css({ margin: 0, color: 'red.600', fontSize: '0.8125rem' })
const summaryCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
})
const summaryTitleCls = css({
  margin: '0.375rem 0 0',
  fontSize: '0.875rem',
  fontWeight: 600,
})
const summaryRowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  gap: '0.75rem',
  alignItems: 'center',
  paddingY: '0.25rem',
  fontSize: '0.8125rem',
})
const mutedCls = css({ color: 'greyscale.500', fontSize: '0.75rem' })
const removeCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  cursor: 'pointer',
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  padding: '0.75rem 1rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
