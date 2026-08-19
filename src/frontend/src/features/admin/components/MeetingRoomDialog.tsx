import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'
import { pathLabelOf } from '@/features/meeting-rooms/utils/roomHierarchy'
import { roomIdentifier } from '@/features/meeting-rooms/utils/roomLabel'

import type {
  AdminMeetingRoom,
  AdminMeetingRoomFacility,
  AdminMeetingRoomNode,
} from '../api/adminMeetingRooms'

export interface MeetingRoomValues {
  name: string
  code: string
  floor: string
  node: string
  capacity: number
  is_active: boolean
  disabled_reason: string
  description: string
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
  const [floor, setFloor] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [capacity, setCapacity] = useState('')
  const [active, setActive] = useState(true)
  const [disabledReason, setDisabledReason] = useState('')
  const [description, setDescription] = useState('')
  const [facilityIds, setFacilityIds] = useState<string[]>([])

  useEffect(() => {
    if (!isOpen) return
    setName(room?.name ?? '')
    setCode(room?.code ?? '')
    setFloor(room?.floor ?? '')
    setNodeId(room?.node ?? defaultNodeId ?? '')
    setCapacity(room && room.capacity > 0 ? String(room.capacity) : '')
    setActive(room?.is_active ?? true)
    setDisabledReason(room?.disabled_reason ?? '')
    setDescription(room?.description ?? '')
    setFacilityIds(room?.facilities.map((f) => f.id) ?? [])
  }, [isOpen, room, defaultNodeId, nodes])

  const buildingNodes = useMemo(
    () => nodes.filter((node) => node.level_type === 'building'),
    [nodes]
  )

  const toggleFacility = (id: string) =>
    setFacilityIds((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    )

  // 停用的设施不再可选,但这间房已经贴着的仍然列出并可摘除 —— 否则表格里显示
  // 着「投影仪」,编辑框里却找不到它。
  const offerableFacilities = facilities.filter(
    (f) => f.is_active || facilityIds.includes(f.id)
  )

  const trimmedName = name.trim()
  const trimmedCode = code.trim()
  const trimmedFloor = floor.trim()
  const valid =
    !!trimmedCode &&
    !!trimmedFloor &&
    buildingNodes.some((building) => building.id === nodeId)
  const submit = () => {
    if (!valid || submitting) return
    onSubmit({
      name: trimmedName,
      code: trimmedCode,
      floor: trimmedFloor,
      node: nodeId,
      capacity: Number(capacity) || 0,
      is_active: active,
      // 启用中的会议室不留上一次的禁用原因,否则下次禁用时它会诈尸。
      disabled_reason: active ? '' : disabledReason.trim(),
      description: description.trim(),
      facility_ids: facilityIds,
    })
  }

  // 提交前预览完整会议室标识，避免不同建筑的同号会议室混淆。
  // 复用 C 端带测试的路径拼接，避免重复解析不带连字符的 path id。
  const fullLabel = [
    nodeId ? pathLabelOf(nodes, nodeId) : '',
    trimmedFloor,
    roomIdentifier({ code: trimmedCode, name: trimmedName }),
  ]
    .filter(Boolean)
    .join(' · ')

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
          <label className={labelCls} htmlFor="mr-room-code">
            {t('meetingRooms.roomCode')}
          </label>
          {/* eslint-disable jsx-a11y/no-autofocus -- 编号是必填的首字段,新建会议室
              打开就该能直接输。RAC useDialog 默认只聚焦对话框容器,需子元素
              autoFocus 覆盖(机制见 TextPromptDialog.test.tsx)。 */}
          <Input
            autoFocus
            id="mr-room-code"
            required
            aria-label={t('meetingRooms.roomCode')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {/* eslint-enable jsx-a11y/no-autofocus */}
          {fullLabel && (
            <span className={previewCls}>
              {t('meetingRooms.fullNamePreview', { label: fullLabel })}
            </span>
          )}
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-name">
            {t('meetingRooms.roomNameOptional')}
          </label>
          <Input
            id="mr-room-name"
            aria-label={t('meetingRooms.roomNameOptional')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-node">
            {t('meetingRooms.parentLevel')}
          </label>
          {room ? (
            <select
              id="mr-room-node"
              className={cx(selectChrome, selectCls)}
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              required
            >
              {buildingNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {pathLabelOf(nodes, n.id)}
                </option>
              ))}
            </select>
          ) : (
            <div id="mr-room-node" className={readOnlyCls}>
              {nodeId ? pathLabelOf(nodes, nodeId) : ''}
            </div>
          )}
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-floor">
            {t('meetingRooms.floor')}
          </label>
          <Input
            id="mr-room-floor"
            required
            aria-label={t('meetingRooms.floor')}
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
          />
        </div>

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

        {!active && (
          <div className={fieldCls}>
            <label className={labelCls} htmlFor="mr-room-reason">
              {t('meetingRooms.disabledReason')}
            </label>
            <Input
              id="mr-room-reason"
              aria-label={t('meetingRooms.disabledReason')}
              placeholder={t('meetingRooms.disabledReasonHint')}
              value={disabledReason}
              onChange={(e) => setDisabledReason(e.target.value)}
            />
          </div>
        )}

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-room-remark">
            {t('meetingRooms.remark')}
          </label>
          <textarea
            id="mr-room-remark"
            aria-label={t('meetingRooms.remark')}
            rows={2}
            className={textareaCls}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {offerableFacilities.length > 0 && (
          <div className={fieldCls}>
            <span className={labelCls}>{t('meetingRooms.facilities')}</span>
            <div className={chipRowCls}>
              {offerableFacilities.map((facility) => {
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
const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })
const readOnlyCls = css({
  minHeight: '2.25rem',
  display: 'flex',
  alignItems: 'center',
  paddingX: '0.625rem',
  borderRadius: 4,
  backgroundColor: 'greyscale.100',
  color: 'greyscale.700',
  fontSize: '0.875rem',
})
// 与同框的 Input 基元同款外观(边框/圆角/左内边距/文字色)。原先只有 width +
// fontSize —— appearance:none 把浏览器自带的边框也一并去掉了,于是白底无框的
// 21px 下拉贴在 32px 的 Input 底下,基本看不见是个控件。
// 高度不在这里给,由 selectChrome 统一钉 control.md;左内边距**必须写
// paddingLeft** 不能写 paddingX,否则与 selectChrome 的箭头留位撞同属性。
const selectCls = css({
  width: '100%',
  fontSize: '0.875rem',
  paddingLeft: '0.5',
  border: '1px solid',
  borderColor: 'control.border',
  color: 'control.text',
  borderRadius: 4,
})
const previewCls = css({ fontSize: '0.6875rem', color: 'greyscale.400' })
const textareaCls = css({
  width: '100%',
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
  resize: 'vertical',
})
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
  border: '1px solid token(colors.selected.accent)',
  backgroundColor: 'selected.bg',
  color: 'selected.text',
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.5rem',
})
