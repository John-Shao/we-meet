import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type AdminMeetingRoomFacility,
  type FacilityInput,
  createFacility,
  deleteFacility,
  updateFacility,
} from '../api/adminMeetingRooms'
import { describeApiError } from '../api/errors'

/**
 * 设施类型管理 — 飞书「+ 添加设施类型」的那本字典。
 *
 * The dictionary already existed server-side (P9 chose a table over a JSON tag
 * array precisely so facilities could be renamed and retired); until now the
 * only way to touch it was Django admin.
 *
 * Retiring is the delete button's normal outcome: the server keeps a facility
 * that rooms still reference and just flips `is_active`, so those rooms do not
 * silently lose a label. Retired entries stay listed here, greyed, and can be
 * switched back on.
 */
export const FacilityDictionaryDialog = ({
  isOpen,
  facilities,
  onClose,
}: {
  isOpen: boolean
  facilities: AdminMeetingRoomFacility[]
  onClose: () => void
}) => {
  const { t } = useTranslation('admin')
  const queryClient = useQueryClient()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['admin', 'meetingRoomFacilities'],
    })
    void queryClient.invalidateQueries({ queryKey: ['admin', 'meetingRooms'] })
    // The C-side filter chips read the same dictionary.
    void queryClient.invalidateQueries({ queryKey: ['meeting-rooms'] })
  }
  const onError = (e: unknown) =>
    void showAlert({ message: describeApiError(e) })

  const createMut = useMutation({
    mutationFn: (input: FacilityInput) => createFacility(input),
    onSuccess: () => {
      setNewName('')
      setNewCode('')
      invalidate()
    },
    onError,
  })
  const updateMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: FacilityInput }) =>
      updateFacility(id, input),
    onSuccess: invalidate,
    onError,
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFacility(id),
    onSuccess: invalidate,
    onError,
  })

  const rename = (facility: AdminMeetingRoomFacility) => {
    const next = (editing[facility.id] ?? facility.name).trim()
    setEditing((prev) => {
      const rest = { ...prev }
      delete rest[facility.id]
      return rest
    })
    if (!next || next === facility.name) return
    updateMut.mutate({ id: facility.id, input: { name: next } })
  }

  const remove = async (facility: AdminMeetingRoomFacility) => {
    const ok = await askConfirm({
      message: t('meetingRooms.deleteFacilityConfirm', { name: facility.name }),
      danger: true,
    })
    if (ok) deleteMut.mutate(facility.id)
  }

  return (
    // type="flex":默认 dialog 档定宽 30rem,内容区只剩 27rem,30rem 的列表会溢出。
    <Dialog
      isOpen={isOpen}
      type="flex"
      title={t('meetingRooms.manageFacilities')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className={wrapCls} data-testid="admin-mr-facilities">
        <p className={hintCls}>{t('meetingRooms.facilitiesHint')}</p>

        <div className={listCls}>
          {facilities.length === 0 && (
            <p className={hintCls}>{t('meetingRooms.noFacilities')}</p>
          )}
          {facilities.map((facility) => (
            <div key={facility.id} className={rowCls}>
              <Input
                value={editing[facility.id] ?? facility.name}
                aria-label={t('meetingRooms.facilityName')}
                onChange={(e) =>
                  setEditing((prev) => ({
                    ...prev,
                    [facility.id]: e.target.value,
                  }))
                }
                onBlur={() => rename(facility)}
              />
              <span className={codeCls}>{facility.code || '—'}</span>
              <label className={switchCls}>
                <input
                  type="checkbox"
                  checked={facility.is_active}
                  onChange={(e) =>
                    updateMut.mutate({
                      id: facility.id,
                      input: { is_active: e.target.checked },
                    })
                  }
                />
                {facility.is_active
                  ? t('meetingRooms.statusActive')
                  : t('meetingRooms.retired')}
              </label>
              <Button
                variant="quaternaryDanger"
                size="icon28"
                aria-label={t('actions.delete')}
                tooltip={t('actions.delete')}
                onPress={() => void remove(facility)}
              >
                <RiDeleteBinLine size={16} />
              </Button>
            </div>
          ))}
        </div>

        <form
          className={addRowCls}
          onSubmit={(e) => {
            e.preventDefault()
            const name = newName.trim()
            if (!name || createMut.isPending) return
            createMut.mutate({ name, code: newCode.trim() })
          }}
        >
          <Input
            value={newName}
            aria-label={t('meetingRooms.facilityName')}
            placeholder={t('meetingRooms.facilityName')}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Input
            value={newCode}
            aria-label={t('meetingRooms.facilityCode')}
            placeholder={t('meetingRooms.facilityCodeHint')}
            onChange={(e) => setNewCode(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            icon={<RiAddLine size={16} />}
            isDisabled={!newName.trim() || createMut.isPending}
          >
            {t('meetingRooms.addFacility')}
          </Button>
        </form>

        <div className={footerCls}>
          <Button variant="primary" size="sm" onPress={onClose}>
            {t('actions.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const wrapCls = css({ width: 'min(30rem, calc(100vw - 6rem))' })
const hintCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.500',
  marginBottom: '0.625rem',
})
const listCls = css({
  maxHeight: '18rem',
  overflowY: 'auto',
  marginBottom: '0.75rem',
})
const rowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 6rem 6rem 2rem',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.375rem',
})
const codeCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.400',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const switchCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.75rem',
  color: 'greyscale.700',
  cursor: 'pointer',
})
const addRowCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr auto',
  alignItems: 'center',
  gap: '0.5rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: '0.875rem',
})
