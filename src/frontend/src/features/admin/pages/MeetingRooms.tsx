import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiAddLine, RiMoreFill } from '@remixicon/react'
import {
  Button as RACButton,
  Menu as RACMenu,
  MenuItem,
} from 'react-aria-components'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'

import {
  type AdminMeetingRoom,
  type AdminMeetingRoomNode,
  createMeetingRoom,
  createRoomNode,
  deleteMeetingRoom,
  deleteRoomNode,
  fetchAdminFacilities,
  fetchAdminMeetingRooms,
  fetchAdminRoomNodes,
  moveRoomNode,
  updateMeetingRoom,
  updateRoomNode,
} from '../api/adminMeetingRooms'
import { describeApiError } from '../api/errors'
import { MeetingRoomNodeTree } from '../components/MeetingRoomNodeTree'
import {
  HierarchyNodeDialog,
  type HierarchyNodeValues,
} from '../components/HierarchyNodeDialog'
import {
  MeetingRoomDialog,
  type MeetingRoomValues,
} from '../components/MeetingRoomDialog'

const NODES_KEY = ['admin', 'meetingRoomNodes']
const ROOMS_KEY = ['admin', 'meetingRooms']

type NodeDialogState =
  | { mode: 'create'; parent: AdminMeetingRoomNode | null }
  | { mode: 'edit'; node: AdminMeetingRoomNode }
  | null

type RoomDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; room: AdminMeetingRoom }
  | null

/**
 * 会议室管理 (P9, M 端) — left: the building / floor tree, right: its rooms.
 *
 * Same shape as the department console so admins do not have to learn a second
 * layout; the differences are what hangs off a node (rooms, not people) and the
 * per-level timezone.
 */
export const AdminMeetingRooms = () => {
  const { t } = useTranslation('admin')
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const queryClient = useQueryClient()

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState>(null)
  const [roomDialog, setRoomDialog] = useState<RoomDialogState>(null)
  const [page, setPage] = useState(1)

  const { data: nodes = [] } = useQuery({
    queryKey: NODES_KEY,
    queryFn: fetchAdminRoomNodes,
    staleTime: 30_000,
  })
  const { data: facilities = [] } = useQuery({
    queryKey: ['admin', 'meetingRoomFacilities'],
    queryFn: fetchAdminFacilities,
    staleTime: 5 * 60_000,
  })
  const { data: rooms, isFetching: roomsFetching } = useQuery({
    queryKey: [...ROOMS_KEY, selectedNodeId ?? '', page],
    queryFn: () => fetchAdminMeetingRooms({ node: selectedNodeId, page }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: NODES_KEY })
    void queryClient.invalidateQueries({ queryKey: ROOMS_KEY })
    // The C side reads the same hierarchy — keep the picker honest.
    void queryClient.invalidateQueries({ queryKey: ['meeting-rooms'] })
  }
  const onError = (e: unknown) => void showAlert({ message: describeApiError(e) })

  const nodeMutation = useMutation({
    mutationFn: async (values: HierarchyNodeValues) => {
      if (nodeDialog?.mode === 'edit') {
        const node = nodeDialog.node
        await updateRoomNode(node.id, {
          name: values.name,
          timezone: values.timezone,
        })
        // Reparenting rewrites a subtree, so it is a separate endpoint.
        if ((node.parent ?? null) !== values.parent) {
          await moveRoomNode(node.id, values.parent)
        }
        return
      }
      await createRoomNode(values)
    },
    onSuccess: () => {
      setNodeDialog(null)
      invalidate()
    },
    onError,
  })

  const roomMutation = useMutation({
    mutationFn: (values: MeetingRoomValues) =>
      roomDialog?.mode === 'edit'
        ? updateMeetingRoom(roomDialog.room.id, values)
        : createMeetingRoom(values),
    onSuccess: () => {
      setRoomDialog(null)
      invalidate()
    },
    onError,
  })

  const deleteRoomMutation = useMutation({
    mutationFn: (id: string) => deleteMeetingRoom(id),
    onSuccess: invalidate,
    onError,
  })

  const deleteNodeMutation = useMutation({
    mutationFn: (id: string) => deleteRoomNode(id),
    onSuccess: () => {
      setSelectedNodeId(null)
      invalidate()
    },
    onError,
  })

  const confirmDeleteRoom = async (room: AdminMeetingRoom) => {
    const ok = await askConfirm({
      message: t('meetingRooms.deleteRoomConfirm', { name: room.name }),
      danger: true,
    })
    if (ok) deleteRoomMutation.mutate(room.id)
  }

  const confirmDeleteNode = async (node: AdminMeetingRoomNode) => {
    const ok = await askConfirm({
      message: t('meetingRooms.deleteLevelConfirm', { name: node.name }),
      danger: true,
    })
    if (ok) deleteNodeMutation.mutate(node.id)
  }

  const selectNode = (id: string | null) => {
    setSelectedNodeId(id)
    setPage(1)
  }

  const rows = rooms?.results ?? []

  return (
    <div className={pageCls}>
      <div className={headerCls}>
        <h1 className={titleCls}>{t('meetingRooms.title')}</h1>
        <div className={css({ display: 'flex', gap: '0.5rem' })}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RiAddLine size={16} />}
            onPress={() => setNodeDialog({ mode: 'create', parent: null })}
          >
            {t('meetingRooms.newLevel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<RiAddLine size={16} />}
            isDisabled={nodes.length === 0}
            onPress={() => setRoomDialog({ mode: 'create' })}
            data-testid="admin-mr-add"
          >
            {t('meetingRooms.newRoom')}
          </Button>
        </div>
      </div>

      <div className={bodyCls}>
        <ResizablePanel
          storageKey="we-meet:admin-meeting-rooms-tree-width"
          defaultWidth={300}
          min={240}
          max={480}
        >
          <aside className={asideCls}>
            {nodes.length === 0 ? (
              <p className={hintCls}>{t('meetingRooms.emptyLevels')}</p>
            ) : (
              <MeetingRoomNodeTree
                nodes={nodes}
                selectedId={selectedNodeId}
                onSelect={selectNode}
                onAddChild={(parent) => setNodeDialog({ mode: 'create', parent })}
                onEdit={(node) => setNodeDialog({ mode: 'edit', node })}
                onDelete={(node) => void confirmDeleteNode(node)}
              />
            )}
          </aside>
        </ResizablePanel>

        <main className={mainCls}>
          {roomsFetching && rows.length === 0 ? (
            <p className={hintCls}>{t('meetingRooms.loading')}</p>
          ) : rows.length === 0 ? (
            <p className={hintCls}>{t('meetingRooms.emptyRooms')}</p>
          ) : (
            <>
              <table className={tableCls}>
                <thead>
                  <tr className={theadRowCls}>
                    <th className={thCls}>{t('meetingRooms.colName')}</th>
                    <th className={thCls}>{t('meetingRooms.colLevel')}</th>
                    <th className={thCls}>{t('meetingRooms.colCapacity')}</th>
                    <th className={thCls}>{t('meetingRooms.colFacilities')}</th>
                    <th className={thCls}>{t('meetingRooms.colStatus')}</th>
                    <th className={css({ width: '3rem' })} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((room) => (
                    <tr
                      key={room.id}
                      className={trCls}
                      data-testid={`admin-mr-row-${room.id}`}
                    >
                      <td className={tdCls}>
                        <span className={roomNameCls}>{room.name}</span>
                        {room.code && (
                          <span className={roomCodeCls}> · {room.code}</span>
                        )}
                      </td>
                      <td className={tdCls}>{room.path_label}</td>
                      <td className={tdCls}>
                        {room.capacity > 0 ? room.capacity : '—'}
                      </td>
                      <td className={tdCls}>
                        {room.facilities.length === 0
                          ? '—'
                          : room.facilities
                              .slice(0, 3)
                              .map((f) => f.name)
                              .join('、') +
                            (room.facilities.length > 3
                              ? ` +${room.facilities.length - 3}`
                              : '')}
                      </td>
                      <td className={tdCls}>
                        <span
                          className={
                            room.is_active ? badgeActiveCls : badgeDisabledCls
                          }
                        >
                          {room.is_active
                            ? t('meetingRooms.statusActive')
                            : t('meetingRooms.statusDisabled')}
                        </span>
                      </td>
                      <td className={tdCls}>
                        <Menu>
                          <RACButton
                            aria-label={t('meetingRooms.rowActions')}
                            className={iconBtnCls}
                          >
                            <RiMoreFill size={18} />
                          </RACButton>
                          <RACMenu className={menuListCls}>
                            <MenuItem
                              className={menuItemCls}
                              onAction={() =>
                                setRoomDialog({ mode: 'edit', room })
                              }
                            >
                              {t('actions.edit')}
                            </MenuItem>
                            <MenuItem
                              className={menuItemCls}
                              onAction={() =>
                                updateMeetingRoom(room.id, {
                                  is_active: !room.is_active,
                                })
                                  .then(invalidate)
                                  .catch(onError)
                              }
                            >
                              {room.is_active
                                ? t('meetingRooms.disable')
                                : t('meetingRooms.enable')}
                            </MenuItem>
                            <MenuItem
                              className={menuItemDangerCls}
                              onAction={() => void confirmDeleteRoom(room)}
                            >
                              {t('actions.delete')}
                            </MenuItem>
                          </RACMenu>
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className={pagerCls}>
                <button
                  type="button"
                  className={pagerBtnCls}
                  disabled={!rooms?.previous}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  {t('actions.previous')}
                </button>
                <button
                  type="button"
                  className={pagerBtnCls}
                  disabled={!rooms?.next}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t('actions.next')}
                </button>
              </div>
            </>
          )}
        </main>
      </div>

      <HierarchyNodeDialog
        isOpen={nodeDialog !== null}
        node={nodeDialog?.mode === 'edit' ? nodeDialog.node : null}
        parent={nodeDialog?.mode === 'create' ? nodeDialog.parent : null}
        nodes={nodes}
        submitting={nodeMutation.isPending}
        onSubmit={(values) => nodeMutation.mutate(values)}
        onClose={() => setNodeDialog(null)}
      />
      <MeetingRoomDialog
        isOpen={roomDialog !== null}
        room={roomDialog?.mode === 'edit' ? roomDialog.room : null}
        defaultNodeId={selectedNodeId}
        nodes={nodes}
        facilities={facilities}
        submitting={roomMutation.isPending}
        onSubmit={(values) => roomMutation.mutate(values)}
        onClose={() => setRoomDialog(null)}
      />
    </div>
  )
}

const pageCls = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
})
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const bodyCls = css({
  flex: 1,
  display: 'flex',
  minHeight: 0,
  overflow: 'hidden',
})
const asideCls = css({
  width: '100%',
  height: '100%',
  borderRight: '1px solid token(colors.greyscale.200)',
  overflowY: 'auto',
  backgroundColor: 'greyscale.50',
})
const mainCls = css({
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '1.25rem',
})
const hintCls = css({ color: 'greyscale.500', fontSize: '0.875rem' })
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
const thCls = css({ paddingY: '0.5rem', paddingRight: '0.75rem', fontWeight: 'medium' })
const trCls = css({
  borderBottom: '1px solid token(colors.greyscale.100)',
  _hover: { backgroundColor: 'greyscale.50' },
})
const tdCls = css({ paddingY: '0.625rem', paddingRight: '0.75rem', color: 'greyscale.700' })
const roomNameCls = css({ fontWeight: 'medium', color: 'greyscale.900' })
const roomCodeCls = css({ color: 'greyscale.400' })
const badgeBase = {
  paddingX: '0.5rem',
  paddingY: '0.125rem',
  borderRadius: '0.375rem',
  fontSize: '0.75rem',
} as const
const badgeActiveCls = css({
  ...badgeBase,
  backgroundColor: 'primary.100',
  color: 'primary.700',
  _dark: { backgroundColor: 'primaryDark.100', color: 'primaryDark.800' },
})
const badgeDisabledCls = css({
  ...badgeBase,
  backgroundColor: 'greyscale.100',
  color: 'greyscale.600',
})
const iconBtnCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.75rem',
  height: '1.75rem',
  border: 'none',
  borderRadius: '0.375rem',
  background: 'transparent',
  color: 'greyscale.500',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.200', color: 'greyscale.800' },
})
const menuListCls = css({
  padding: '0.25rem',
  borderRadius: '0.5rem',
  border: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  outline: 'none',
})
const menuItemBase = {
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  outline: 'none',
} as const
const menuItemCls = css({
  ...menuItemBase,
  color: 'greyscale.800',
  _hover: { backgroundColor: 'greyscale.100' },
})
const menuItemDangerCls = css({
  ...menuItemBase,
  color: 'danger.600',
  _hover: { backgroundColor: 'danger.50' },
})
const pagerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '1rem',
})
const pagerBtnCls = css({
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  cursor: 'pointer',
  _disabled: { opacity: 0.4, cursor: 'not-allowed' },
})
