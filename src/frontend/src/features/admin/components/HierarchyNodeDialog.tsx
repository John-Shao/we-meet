import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'
import { buildTimezoneOptions } from '@/utils/timezoneOptions'

import type { AdminMeetingRoomNode } from '../api/adminMeetingRooms'

export interface HierarchyNodeValues {
  name: string
  /** '' = inherit from ancestors. */
  timezone: string
  /** null = top level. Only applied on create / move. */
  parent: string | null
}

/**
 * Add / edit a level in the room hierarchy (P9) — name, parent, timezone.
 *
 * On edit, the parent list excludes the node itself and its own descendants:
 * hosting a level under its own child would make a cycle, and the server
 * rejects it anyway.
 */
export const HierarchyNodeDialog = ({
  isOpen,
  node,
  parent,
  nodes,
  submitting,
  onSubmit,
  onClose,
}: {
  isOpen: boolean
  /** The node being edited, or null when creating. */
  node: AdminMeetingRoomNode | null
  /** Preselected parent when creating from a tree row's ＋. */
  parent: AdminMeetingRoomNode | null
  nodes: AdminMeetingRoomNode[]
  submitting?: boolean
  onSubmit: (values: HierarchyNodeValues) => void
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('admin')
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('')
  const [parentId, setParentId] = useState<string>('')

  // ~400 zones × 3 Intl formatters — build once the dialog is actually open,
  // and only once per language (the util caches across mounts).
  const zones = useMemo(
    () => (isOpen ? buildTimezoneOptions(i18n.language) : []),
    [isOpen, i18n.language]
  )

  useEffect(() => {
    if (!isOpen) return
    setName(node?.name ?? '')
    setTimezone(node?.timezone ?? '')
    setParentId(node ? (node.parent ?? '') : (parent?.id ?? ''))
  }, [isOpen, node, parent])

  const candidates = node
    ? nodes.filter((n) => !n.path.startsWith(node.path))
    : nodes

  const trimmed = name.trim()
  const submit = () => {
    if (!trimmed || submitting) return
    onSubmit({ name: trimmed, timezone, parent: parentId || null })
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={node ? t('meetingRooms.editLevel') : t('meetingRooms.newLevel')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-testid="admin-mr-node-dialog"
      >
        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-node-parent">
            {t('meetingRooms.parentLevel')}
          </label>
          <select
            id="mr-node-parent"
            className={cx(selectChrome, selectCls)}
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">{t('meetingRooms.topLevel')}</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>
                {`${'  '.repeat(n.depth)}${n.name}`}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-node-name">
            {t('meetingRooms.levelName')}
          </label>
          <Input
            id="mr-node-name"
            aria-label={t('meetingRooms.levelName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className={fieldCls}>
          <label className={labelCls} htmlFor="mr-node-tz">
            {t('meetingRooms.levelTimezone')}
          </label>
          <select
            id="mr-node-tz"
            className={cx(selectChrome, selectCls)}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            <option value="">{t('meetingRooms.timezoneInherit')}</option>
            {zones.map(({ zone, label }) => (
              <option key={zone} value={zone}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className={footerCls}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={!trimmed || submitting}
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
  minWidth: '20rem',
})
const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })
// 同 MeetingRoomDialog:补齐边框/圆角,appearance:none 会把浏览器自带边框一起
// 去掉,原先是个白底无框的 21px 下拉。高度由 selectChrome 统一给;左内边距用
// paddingLeft 而非 paddingX,避免与 selectChrome 的箭头留位撞同属性。
const selectCls = css({
  width: '100%',
  fontSize: '0.875rem',
  paddingLeft: '0.5',
  border: '1px solid',
  borderColor: 'control.border',
  color: 'control.text',
  borderRadius: 4,
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.5rem',
})
