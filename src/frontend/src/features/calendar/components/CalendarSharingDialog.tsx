import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { Button, SegmentedControl } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'
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
import { labelCls } from './formStyles'

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
  const [applying, setApplying] = useState(false)
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
    setApplying(true)
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
      setApplying(false)
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
      <ModalHeader
        title={t('sharing.title')}
        onClose={onClose}
        closeLabel={t('form.cancel')}
      />
      <ModalBody padding="none">
        <div className={bodyStackCls}>
          <div className={defaultRowCls}>
            <label className={labelCls} htmlFor="calendar-default-access">
              {t('sharing.organizationDefault')}
            </label>
            <Select
              id="calendar-default-access"
              aria-label={t('sharing.organizationDefault')}
              selectedKey={mine?.organization_default_access ?? 'free_busy'}
              onSelectionChange={(key) =>
                void changeDefault(String(key) as CalendarPermission)
              }
              isDisabled={!mine || busy}
              className={accessSelectCls}
              items={[
                { value: 'none', label: t('sharing.none') },
                { value: 'free_busy', label: t('sharing.freeBusy') },
                { value: 'details', label: t('sharing.details') },
              ]}
            />
          </div>

          <div className={tabsCls}>
            <SegmentedControl
              value={mode}
              ariaLabel={t('sharing.title')}
              density="compact"
              items={([
                { id: 'share', label: t('sharing.share') },
                { id: 'subscribe', label: t('sharing.subscribe') },
              ] as const)}
              onChange={(value) => {
                setMode(value)
                setSelected(new Map())
                setError('')
              }}
            />
            {mode === 'share' && (
              <Select
                aria-label={`${t('sharing.share')}: ${t('sharing.details')}`}
                selectedKey={permission}
                onSelectionChange={(key) =>
                  setPermission(String(key) as 'free_busy' | 'details')
                }
                className={permissionSelectCls}
                items={[
                  { value: 'free_busy', label: t('sharing.freeBusy') },
                  { value: 'details', label: t('sharing.details') },
                ]}
              />
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
          {error && <StateHint state="error">{error}</StateHint>}

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
                  <Button
                    variant="secondaryText"
                    size="dense"
                    isDisabled={busy}
                    onPress={() =>
                      void remove(() => deleteCalendarGrant(grant.id))
                    }
                  >
                    {t('sharing.remove')}
                  </Button>
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
                  <Button
                    variant="secondaryText"
                    size="dense"
                    isDisabled={busy}
                    onPress={() =>
                      void remove(() => unsubscribeCalendar(subscription.id))
                    }
                  >
                    {t('sharing.unsubscribe')}
                  </Button>
                </div>
              ))
            )}
          </section>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={() => void apply()}
          isDisabled={busy || selected.size === 0}
          loading={applying}
        >
          {t(
            mode === 'share' ? 'sharing.shareAction' : 'sharing.subscribeAction'
          )}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

const bodyStackCls = css({
  padding: 'lg',
  display: 'flex',
  flexDirection: 'column',
  gap: 'lg',
})
const defaultRowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 220px',
  alignItems: 'center',
  gap: 'lg',
})
const tabsCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'sm',
  flexWrap: 'wrap',
})
const accessSelectCls = css({ width: '220px' })
const permissionSelectCls = css({ width: '180px' })
const pickerCls = css({
  height: '260px',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'panel',
  overflow: 'hidden',
})
const summaryCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
})
const summaryTitleCls = css({
  margin: 'xs 0 0',
  textStyle: 'titleSmall',
  color: 'text.primary',
})
const summaryRowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  gap: 'md',
  alignItems: 'center',
  paddingY: 'xs',
  textStyle: 'bodySmall',
  color: 'text.primary',
})
const mutedCls = css({ color: 'text.secondary', textStyle: 'bodySmall' })
