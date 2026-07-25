import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'

import type {
  AdminMeetingRoom,
  AdminMeetingRoomFacility,
  AdminMeetingRoomNode,
} from '../api/adminMeetingRooms'

export interface MeetingRoomValues {
  name: string
  code: string
  node: string
  capacity: number
  is_active: boolean
  facility_ids: string[]
}

/**
 * Add / edit a bookable room (P9) — the 「添加会议室」 dialog.
 *
 * Fields mirror the Feishu console: level, name, capacity, status, facilities.
 * The level list is a flat indented `<select>` rather than a tree picker; a
 * building hierarchy is small enough that a second tree widget would cost more
 * than it explains.
 */
export const MeetingRoomDialog = ({
  isOpen,
  room,
  defaultNodeId,
  nodes,
  facilities,
  submitting,
  onSubmit,
  onClose,
}: {
  isOpen: boolean
  /** The room being edited, or null when creating. */
  room: AdminMeetingRoom | null
  defaultNodeId: string | null
  nodes: AdminMeetingRoomNode[]
  facilities: AdminMeetingRoomFacility[]
  submitting?: boolean
  onSubmit: (values: MeetingRoomValues) => void
  onClose: () => void
}) => {
  const { t } = useTranslation('admin')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [capacity, setCapacity] = useState('')
  const [active, setActive] = useState(true)
  const [facilityIds, setFacilityIds] = useState<string[]>([])

  useEffect(() => {
    if (!isOpen) return
    setName(room?.name ?? '')
    setCode(room?.code ?? '')
    setNodeId(room?.node ?? defaultNodeId ?? nodes[0]?.id ?? '')
    setCapacity(room && room.capacity > 0 ? String(room.capacity) : '')
    setActive(room?.is_active ?? true)
    setFacilityIds(room?.facilities.map((f) => f.id) ?? [])
  }, [isOpen, room, defaultNodeId, nodes])

  const toggleFacility = (id: string) =>
    setFacilityIds((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    )

  const trimmed = name.trim()
  const valid = !!trimmed && !!nodeId
  const submit = () => {
    if (!valid || submitting) return
    onSubmit({
      name: trimmed,
      code: code.trim(),
      node: nodeId,
      capacity: Number(capacity) || 0,
      is_active: active,
      facility_ids: facilityIds,
    })
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={room ? t('meetingRooms.editRoom') : t('meetingRooms.newRoom')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-testid="admin-mr-dialog"
      >
        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-name">
            {t('meetingRooms.roomName')}
          </label>
          <Input
            id="mr-room-name"
            aria-label={t('meetingRooms.roomName')}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-node">
            {t('meetingRooms.parentLevel')}
          </label>
          <select
            id="mr-room-node"
            className={cx(selectChrome, selectCls)}
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {`${'  '.repeat(n.depth)}${n.name}`}
              </option>
            ))}
          </select>
        </div>

        <div className={rowCls}>
          <div className={fieldCls}>
            <label className={labelCls} htmlFor="mr-room-capacity">
              {t('meetingRooms.capacity')}
            </label>
            <Input
              id="mr-room-capacity"
              type="number"
              min={0}
              aria-label={t('meetingRooms.capacity')}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </div>
          <div className={fieldCls}>
            <label className={labelCls} htmlFor="mr-room-code">
              {t('meetingRooms.roomCode')}
            </label>
            <Input
              id="mr-room-code"
              aria-label={t('meetingRooms.roomCode')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        </div>

        <div className={fieldCls}>
          <span className={labelCls}>{t('meetingRooms.colStatus')}</span>
          <label className={checkRowCls}>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('meetingRooms.statusActive')}
          </label>
        </div>

        {facilities.length > 0 && (
          <div className={fieldCls}>
            <span className={labelCls}>{t('meetingRooms.facilities')}</span>
            <div className={chipRowCls}>
              {facilities.map((facility) => {
                const on = facilityIds.includes(facility.id)
                return (
                  <button
                    key={facility.id}
                    type="button"
                    onClick={() => toggleFacility(facility.id)}
                    aria-pressed={on}
                    /* Two complete classes — cx-layering colour utilities is
                       decided by stylesheet order, not by write order. */
                    className={on ? chipOnCls : chipOffCls}
                  >
                    {facility.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className={footerCls}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={!valid || submitting}
            loading={submitting}
          >
            {t('actions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const fieldCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  marginBottom: '0.875rem',
  flex: 1,
  minWidth: '10rem',
})
const rowCls = css({ display: 'flex', gap: '0.75rem', minWidth: '22rem' })
const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })
const selectCls = css({ width: '100%', fontSize: '0.875rem' })
const checkRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.875rem',
  color: 'greyscale.800',
})
const chipRowCls = css({ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' })
const chipBase = {
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  cursor: 'pointer',
} as const
const chipOffCls = css({
  ...chipBase,
  border: '1px solid token(colors.greyscale.300)',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
})
const chipOnCls = css({
  ...chipBase,
  border: '1px solid token(colors.primary.500)',
  backgroundColor: 'primary.100',
  color: 'primary.700',
  _dark: {
    borderColor: 'primaryDark.500',
    backgroundColor: 'primaryDark.100',
    color: 'primaryDark.800',
  },
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.5rem',
})
