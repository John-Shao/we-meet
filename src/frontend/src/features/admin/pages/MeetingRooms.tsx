import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiAddLine, RiMoreFill, RiSearchLine, RiToolsLine } from '@remixicon/react'
import { Menu as RACMenu, MenuItem } from 'react-aria-components'
import Table, { type ColumnProps } from '@douyinfe/semi-ui/lib/es/table'

import { css, cx } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { selectChrome } from '@/primitives/selectChrome'
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
import { MeetingRoomDetail } from '../components/MeetingRoomDetail'
import { FacilityDictionaryDialog } from '../components/FacilityDictionaryDialog'
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
const FACILITIES_KEY = ['admin', 'meetingRoomFacilities']
/** 与后端 REST_FRAMEWORK.PAGE_SIZE 一致(settings.py)。Semi 分页要显式给。 */
const ROOMS_PAGE_SIZE = 20
/** 容量筛选的常用档位 —— 运营找「能坐下这场会的房间」,不是精确匹配人数。 */
const CAPACITY_STEPS = [5, 10, 20, 50]

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
 *
 * `roomId` (from `/admin/meeting-rooms/:roomId`) swaps the right-hand pane for
 * one room's detail. The tree stays put — same as 飞书, and it keeps "where am
 * I in the building" answered while you edit.
 */
export const AdminMeetingRooms = ({ roomId }: { roomId?: string }) => {
  const { t } = useTranslation('admin')
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const queryClient = useQueryClient()
  const [, navigate] = useLocation()

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState>(null)
  const [roomDialog, setRoomDialog] = useState<RoomDialogState>(null)
  const [facilityDialogOpen, setFacilityDialogOpen] = useState(false)
  const [page, setPage] = useState(1)

  // 树搜索与表格搜索是两个框:一个在层级里找楼层,一个在结果里找房间。
  const [treeQuery, setTreeQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [capacityMin, setCapacityMin] = useState('')
  const [facilityFilter, setFacilityFilter] = useState<string[]>([])

  const { data: nodes = [] } = useQuery({
    queryKey: NODES_KEY,
    queryFn: fetchAdminRoomNodes,
    staleTime: 30_000,
  })
  const { data: facilities = [] } = useQuery({
    queryKey: FACILITIES_KEY,
    queryFn: fetchAdminFacilities,
    staleTime: 5 * 60_000,
  })

  const filters = {
    node: selectedNodeId,
    q,
    is_active: status,
    facilities: facilityFilter,
    capacity_min: capacityMin ? Number(capacityMin) : null,
    page,
  }
  const { data: rooms, isFetching: roomsFetching } = useQuery({
    queryKey: [...ROOMS_KEY, filters],
    queryFn: () => fetchAdminMeetingRooms(filters),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    // The detail view fetches its own room; paging the list underneath it would
    // be work nobody can see.
    enabled: !roomId,
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
    // Picking a floor while a room is open means "show me that floor".
    if (roomId) navigate('/meeting-rooms')
  }

  const resetPage = <T,>(set: (v: T) => void) => (value: T) => {
    set(value)
    setPage(1)
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const childLevels = useMemo(
    () => nodes.filter((n) => (n.parent ?? null) === selectedNodeId).length,
    [nodes, selectedNodeId]
  )

  // 停用的设施不再出现在筛选器里,但已经贴在某间房上的仍会在表格里显示 ——
  // 「不能再选」和「历史记录消失」是两回事。
  const activeFacilities = facilities.filter((f) => f.is_active)

  const toggleFacilityFilter = (id: string) => {
    setFacilityFilter((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    )
    setPage(1)
  }

  const columns: ColumnProps<AdminMeetingRoom>[] = [
    {
      title: t('meetingRooms.colName'),
      dataIndex: 'id',
      // ⚠️ 每一列都要给宽度:Semi Table 只要有一列带 width 就切到
      // table-layout: fixed,富余宽度会全部灌给唯一没设宽度的那列。
      width: 260,
      render: (_: unknown, room: AdminMeetingRoom) => (
        <button
          type="button"
          className={roomLinkCls}
          onClick={() => navigate(`/meeting-rooms/${room.id}`)}
          data-testid={`admin-mr-open-${room.id}`}
        >
          <span className={roomNameCls}>{room.name}</span>
          {/* 飞书同款:名称下压一行完整路径,免得两个「401」分不清是哪栋楼的。 */}
          <span className={roomPathCls}>{room.path_label}</span>
        </button>
      ),
    },
    {
      title: t('meetingRooms.roomCode'),
      width: 130,
      render: (_: unknown, room: AdminMeetingRoom) => room.code || '—',
    },
    {
      title: t('meetingRooms.colCapacity'),
      width: 90,
      render: (_: unknown, room: AdminMeetingRoom) =>
        room.capacity > 0 ? room.capacity : '—',
    },
    {
      title: t('meetingRooms.colStatus'),
      width: 110,
      render: (_: unknown, room: AdminMeetingRoom) => (
        <span className={room.is_active ? badgeActiveCls : badgeDisabledCls}>
          {room.is_active
            ? t('meetingRooms.statusActive')
            : t('meetingRooms.statusDisabled')}
        </span>
      ),
    },
    {
      title: t('meetingRooms.colFacilities'),
      width: 200,
      render: (_: unknown, room: AdminMeetingRoom) =>
        room.facilities.length === 0
          ? '—'
          : room.facilities
              .slice(0, 3)
              .map((f) => f.name)
              .join('、') +
            (room.facilities.length > 3
              ? ` +${room.facilities.length - 3}`
              : ''),
    },
    {
      title: t('meetingRooms.colBookingScope'),
      width: 150,
      render: (_: unknown, room: AdminMeetingRoom) =>
        room.booking_scope === 'departments'
          ? room.bookable_departments.map((d) => d.name).join('、') ||
            t('meetingRooms.scopeDepartments')
          : t('meetingRooms.scopeOrg'),
    },
    {
      title: '',
      width: 110,
      render: (_: unknown, room: AdminMeetingRoom) => (
        <div className={rowActionsCls}>
          <Button
            variant="quaternaryText"
            size="sm"
            onPress={() => navigate(`/meeting-rooms/${room.id}`)}
          >
            {t('actions.edit')}
          </Button>
          <Menu>
            <Button
              variant="quaternaryText"
              size="icon28"
              aria-label={t('meetingRooms.rowActions')}
            >
              <RiMoreFill size={18} />
            </Button>
            <RACMenu className={menuListCls}>
              <MenuItem
                className={menuItemCls}
                onAction={() => setRoomDialog({ mode: 'edit', room })}
              >
                {t('meetingRooms.quickEdit')}
              </MenuItem>
              <MenuItem
                className={menuItemCls}
                onAction={() =>
                  updateMeetingRoom(room.id, { is_active: !room.is_active })
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
        </div>
      ),
    },
  ]

  return (
    <div className={pageCls}>
      <div className={headerCls}>
        <h1 className={titleCls}>{t('meetingRooms.title')}</h1>
        <div className={css({ display: 'flex', gap: '0.5rem' })}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RiToolsLine size={16} />}
            onPress={() => setFacilityDialogOpen(true)}
          >
            {t('meetingRooms.manageFacilities')}
          </Button>
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
            <div className={treeSearchCls}>
              <input
                value={treeQuery}
                onChange={(e) => setTreeQuery(e.target.value)}
                placeholder={t('meetingRooms.searchLevels')}
                aria-label={t('meetingRooms.searchLevels')}
                className={treeSearchInputCls}
              />
            </div>
            {nodes.length === 0 ? (
              <p className={css({ padding: '0.75rem', ...hintStyle })}>
                {t('meetingRooms.emptyLevels')}
              </p>
            ) : (
              <MeetingRoomNodeTree
                nodes={nodes}
                query={treeQuery}
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
          {roomId ? (
            <MeetingRoomDetail
              roomId={roomId}
              nodes={nodes}
              facilities={facilities}
              onBack={() => navigate('/meeting-rooms')}
              onSaved={invalidate}
            />
          ) : (
            <>
              <div className={summaryCls}>
                <h2 className={summaryTitleCls}>
                  {selectedNode?.name ?? t('meetingRooms.allRooms')}
                </h2>
                <span className={summaryHintCls}>
                  {t('meetingRooms.levelSummary', {
                    rooms: rooms?.count ?? 0,
                    levels: childLevels,
                  })}
                </span>
              </div>

              <div className={toolbarCls}>
                <select
                  value={status}
                  onChange={(e) => resetPage(setStatus)(e.target.value)}
                  aria-label={t('meetingRooms.colStatus')}
                  className={filterSelectCls}
                >
                  <option value="">{t('meetingRooms.filterAllStatus')}</option>
                  <option value="1">{t('meetingRooms.statusActive')}</option>
                  <option value="0">{t('meetingRooms.statusDisabled')}</option>
                </select>
                <select
                  value={capacityMin}
                  onChange={(e) => resetPage(setCapacityMin)(e.target.value)}
                  aria-label={t('meetingRooms.capacity')}
                  className={filterSelectCls}
                >
                  <option value="">{t('meetingRooms.filterAnyCapacity')}</option>
                  {CAPACITY_STEPS.map((n) => (
                    <option key={n} value={n}>
                      {t('meetingRooms.filterCapacityAtLeast', { count: n })}
                    </option>
                  ))}
                </select>
                <form
                  className={searchFormCls}
                  onSubmit={(e) => {
                    e.preventDefault()
                    setQ(searchInput.trim())
                    setPage(1)
                  }}
                >
                  <input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder={t('meetingRooms.searchPlaceholder')}
                    aria-label={t('meetingRooms.searchPlaceholder')}
                    className={searchInputCls}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    aria-label={t('meetingRooms.search')}
                  >
                    <RiSearchLine size={16} />
                  </Button>
                </form>
              </div>

              {activeFacilities.length > 0 && (
                <div className={facilityFilterCls}>
                  <span className={facilityFilterLabelCls}>
                    {t('meetingRooms.colFacilities')}
                  </span>
                  {activeFacilities.map((facility) => {
                    const on = facilityFilter.includes(facility.id)
                    return (
                      <button
                        key={facility.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleFacilityFilter(facility.id)}
                        className={on ? chipOnCls : chipOffCls}
                      >
                        {facility.name}
                      </button>
                    )
                  })}
                </div>
              )}

              <Table
                columns={columns}
                dataSource={rooms?.results ?? []}
                rowKey="id"
                size="middle"
                loading={roomsFetching && !rooms}
                empty={t('meetingRooms.emptyRooms')}
                pagination={{
                  currentPage: page,
                  pageSize: ROOMS_PAGE_SIZE,
                  total: rooms?.count ?? 0,
                  onPageChange: setPage,
                  showTotal: false,
                }}
              />
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
      <FacilityDictionaryDialog
        isOpen={facilityDialogOpen}
        facilities={facilities}
        onClose={() => setFacilityDialogOpen(false)}
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
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid token(colors.greyscale.200)',
  overflowY: 'auto',
  backgroundColor: 'greyscale.50',
})
const treeSearchCls = css({
  flexShrink: 0,
  padding: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const treeSearchInputCls = css({
  width: '100%',
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.8125rem',
})
const mainCls = css({
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '1.25rem',
})
const hintStyle = { color: 'greyscale.500', fontSize: '0.875rem' } as const
const summaryCls = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.625rem',
  marginBottom: '0.75rem',
})
const summaryTitleCls = css({
  fontSize: '1rem',
  fontWeight: '600',
  color: 'greyscale.900',
})
const summaryHintCls = css(hintStyle)
const toolbarCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  flexWrap: 'wrap',
  marginBottom: '0.625rem',
})
const filterSelectCls = cx(
  css({
    padding: '0.375rem 0.5rem',
    border: '1px solid token(colors.control.border)',
    borderRadius: '4px',
    backgroundColor: 'greyscale.000',
    color: 'default.text',
    fontSize: '0.875rem',
  }),
  selectChrome
)
const searchFormCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
})
const searchInputCls = css({
  width: '14rem',
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
})
const facilityFilterCls = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.375rem',
  marginBottom: '0.75rem',
})
const facilityFilterLabelCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.500',
  marginRight: '0.125rem',
})
const chipBase = {
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  cursor: 'pointer',
} as const
// Two complete classes rather than cx-layering the colours: atomic classes
// resolve by stylesheet order, not by the order they are combined.
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
const roomLinkCls = css({
  display: 'block',
  width: '100%',
  border: 'none',
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
  cursor: 'pointer',
  minWidth: 0,
})
const roomNameCls = css({
  display: 'block',
  fontWeight: 'medium',
  color: 'primary.700',
  _dark: { color: 'primaryDark.800' },
})
const roomPathCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const rowActionsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
})
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
const menuListCls = css({
  padding: '0.25rem',
  borderRadius: '0.5rem',
  border: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  boxShadow: 'overlay',
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
