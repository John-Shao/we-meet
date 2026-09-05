import { SelectCompat } from '@/primitives/SelectCompat'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiArrowLeftLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button, Input, TextArea } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { useConfirm } from '@/components/ConfirmProvider'
import { StateHint } from '@/components/StateHint'
import { pathLabelOf } from '@/features/meeting-rooms/utils/roomHierarchy'
import { roomIdentifier } from '@/features/meeting-rooms/utils/roomLabel'

import {
  type AdminMeetingRoom,
  type AdminMeetingRoomFacility,
  type AdminMeetingRoomNode,
  type BookingScope,
  type MeetingRoomInput,
  fetchAdminMeetingRoom,
  updateMeetingRoom,
} from '../api/adminMeetingRooms'
import { fetchAdminDepartments } from '../api/adminDepartments'
import { describeApiError } from '../api/errors'

/** Anchor rail entries, in the order 飞书 stacks them. */
const SECTIONS = ['basic', 'status', 'facilities', 'bookingLimits'] as const
type SectionKey = (typeof SECTIONS)[number]

interface Draft {
  name: string
  code: string
  floor: string
  node: string
  capacity: string
  description: string
  is_active: boolean
  disabled_reason: string
  booking_scope: BookingScope
  bookable_department_ids: string[]
  max_booking_minutes: string
  advance_booking_days: string
}

const toDraft = (room: AdminMeetingRoom): Draft => ({
  name: room.name,
  code: room.code,
  floor: room.floor,
  node: room.node,
  capacity: room.capacity > 0 ? String(room.capacity) : '',
  description: room.description,
  is_active: room.is_active,
  disabled_reason: room.disabled_reason,
  booking_scope: room.booking_scope,
  bookable_department_ids: room.bookable_departments.map((d) => d.id),
  max_booking_minutes: room.max_booking_minutes
    ? String(room.max_booking_minutes)
    : '',
  advance_booking_days: room.advance_booking_days
    ? String(room.advance_booking_days)
    : '',
})

/**
 * One room, in full — 飞书's 会议室详情 laid out as an anchor rail plus sections.
 *
 * The list dialog stays for "add a room / fix a typo"; this is where the long
 * tail lives (备注, 禁用原因, 预定限制). Splitting them keeps the create flow
 * three fields long instead of making every new room a policy decision.
 */
export const MeetingRoomDetail = ({
  roomId,
  nodes,
  facilities,
  onBack,
  onSaved,
}: {
  roomId: string
  nodes: AdminMeetingRoomNode[]
  facilities: AdminMeetingRoomFacility[]
  onBack: () => void
  onSaved: () => void
}) => {
  const { t } = useTranslation('admin')
  const queryClient = useQueryClient()
  const { alert: showAlert } = useConfirm()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [facilityIds, setFacilityIds] = useState<string[]>([])
  const [active, setActive] = useState<SectionKey>('basic')
  const sectionRefs = useRef<Partial<Record<SectionKey, HTMLElement | null>>>(
    {}
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const {
    data: room,
    isLoading,
    error,
    refetch: refetchRoom,
  } = useQuery({
    queryKey: ['admin', 'meetingRoom', roomId],
    queryFn: () => fetchAdminMeetingRoom(roomId),
  })
  const {
    data: departments = [],
    isFetching: departmentsFetching,
    isError: departmentsError,
    refetch: refetchDepartments,
  } = useQuery({
    queryKey: ['admin', 'departments'],
    queryFn: fetchAdminDepartments,
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!room) return
    setDraft(toDraft(room))
    setFacilityIds(room.facilities.map((f) => f.id))
  }, [room])

  const save = useMutation({
    mutationFn: (input: MeetingRoomInput) => updateMeetingRoom(roomId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin', 'meetingRoom', roomId], updated)
      onSaved()
    },
    onError: (e: unknown) => void showAlert({ message: describeApiError(e) }),
  })

  const node = nodes.find((n) => n.id === draft?.node) ?? null
  const buildingNodes = nodes.filter(
    (candidate) => candidate.level_type === 'building'
  )
  // 设施停用后不再可选,但已经贴在这间房上的仍然列出并可摘除 —— 否则管理员
  // 看着表格里有「投影仪」却在编辑页找不到它。
  const offerableFacilities = useMemo(
    () => facilities.filter((f) => f.is_active || facilityIds.includes(f.id)),
    [facilities, facilityIds]
  )

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    // 「已保存」是上一次提交的回执,一旦又改了字段它就不再成立 —— 留着会让人
    // 以为改动已经落库。
    if (save.isSuccess) save.reset()
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const toggleFacility = (id: string) => {
    if (save.isSuccess) save.reset()
    setFacilityIds((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    )
  }

  const scrollTo = (key: SectionKey) => {
    setActive(key)
    sectionRefs.current[key]?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  // 滚动时反向点亮锚点。取「已经越过容器顶部的最后一个 section」,而不是最接近
  // 的那个 —— 后者在长短不一的分区之间会来回跳。
  const onScroll = () => {
    const container = scrollRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top + 8
    let current: SectionKey = SECTIONS[0]
    for (const key of SECTIONS) {
      const el = sectionRefs.current[key]
      if (el && el.getBoundingClientRect().top <= top) current = key
    }
    setActive(current)
  }

  if (isLoading)
    return <StateHint state="loading">{t('meetingRooms.loading')}</StateHint>
  if (error || !room)
    return (
      <div className={detailStateCls}>
        <Button variant="secondary" size="sm" onPress={onBack}>
          {t('actions.back')}
        </Button>
        <StateHint
          state="error"
          action={
            <Button
              variant="secondary"
              size="dense"
              onPress={() => void refetchRoom()}
            >
              {t('feedback.retry')}
            </Button>
          }
        >
          {error ? describeApiError(error) : t('feedback.loadFailed')}
        </StateHint>
      </div>
    )
  if (!draft)
    return <StateHint state="loading">{t('meetingRooms.loading')}</StateHint>

  const submit = () => {
    if (!draft.code.trim() || !draft.floor.trim()) return
    save.mutate({
      name: draft.name.trim(),
      code: draft.code.trim(),
      floor: draft.floor.trim(),
      node: draft.node,
      capacity: Number(draft.capacity) || 0,
      description: draft.description,
      is_active: draft.is_active,
      // 启用中的会议室不该留着上一次的禁用原因,那会在下次禁用时诈尸。
      disabled_reason: draft.is_active ? '' : draft.disabled_reason.trim(),
      facility_ids: facilityIds,
      booking_scope: draft.booking_scope,
      bookable_department_ids:
        draft.booking_scope === 'departments'
          ? draft.bookable_department_ids
          : [],
      max_booking_minutes: Number(draft.max_booking_minutes) || null,
      advance_booking_days: Number(draft.advance_booking_days) || null,
    })
  }

  return (
    <div className={wrapCls}>
      <header className={headerCls}>
        <Button
          variant="quaternaryText"
          size="sm"
          icon={<RiArrowLeftLine size={16} />}
          onPress={onBack}
        >
          {t('actions.back')}
        </Button>
        <div className={css({ minWidth: 0 })}>
          <div className={roomTitleCls}>{roomIdentifier(room)}</div>
          <div className={roomSubtitleCls}>{room.path_label}</div>
        </div>
      </header>

      <div className={columnsCls}>
        <nav className={railCls} aria-label={t('meetingRooms.sections')}>
          {SECTIONS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => scrollTo(key)}
              className={active === key ? railItemActiveCls : railItemCls}
            >
              {t(`meetingRooms.section.${key}`)}
            </button>
          ))}
        </nav>

        <div className={scrollCls} ref={scrollRef} onScroll={onScroll}>
          <Section
            title={t('meetingRooms.section.basic')}
            innerRef={(el) => (sectionRefs.current.basic = el)}
          >
            <Row label={t('meetingRooms.roomCode')}>
              <Input
                required
                value={draft.code}
                aria-label={t('meetingRooms.roomCode')}
                onChange={(e) => set('code', e.target.value)}
              />
            </Row>
            <Row label={t('meetingRooms.roomNameOptional')}>
              <Input
                value={draft.name}
                aria-label={t('meetingRooms.roomNameOptional')}
                onChange={(e) => set('name', e.target.value)}
              />
            </Row>
            <Row label={t('meetingRooms.floor')}>
              <Input
                required
                value={draft.floor}
                aria-label={t('meetingRooms.floor')}
                onChange={(e) => set('floor', e.target.value)}
              />
            </Row>
            <Row label={t('meetingRooms.parentLevel')}>
              <SelectCompat
                value={draft.node}
                aria-label={t('meetingRooms.parentLevel')}
                onChange={(e) => set('node', e.target.value)}
              >
                {buildingNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {pathLabelOf(nodes, n.id)}
                  </option>
                ))}
              </SelectCompat>
            </Row>
            <Row label={t('meetingRooms.capacity')}>
              <Input
                type="number"
                min={0}
                value={draft.capacity}
                aria-label={t('meetingRooms.capacity')}
                onChange={(e) => set('capacity', e.target.value)}
              />
            </Row>
            {/* 时区跟着层级走(空值继承祖先),在这里改一间房的时区只会造出
                第二个真相 —— 只读展示,要改去层级弹窗改。 */}
            <Row label={t('meetingRooms.levelTimezone')}>
              <span className={readOnlyCls}>
                {node?.effective_timezone ?? '—'}
              </span>
            </Row>
            <Row label={t('meetingRooms.remark')}>
              <TextArea
                value={draft.description}
                aria-label={t('meetingRooms.remark')}
                rows={3}
                className={descriptionInputCls}
                onChange={(e) => set('description', e.target.value)}
              />
            </Row>
          </Section>

          <Section
            title={t('meetingRooms.section.status')}
            innerRef={(el) => (sectionRefs.current.status = el)}
          >
            <Row label={t('meetingRooms.colStatus')}>
              <SelectCompat
                value={draft.is_active ? '1' : '0'}
                aria-label={t('meetingRooms.colStatus')}
                onChange={(e) => set('is_active', e.target.value === '1')}
              >
                <option value="1">{t('meetingRooms.statusActive')}</option>
                <option value="0">{t('meetingRooms.statusDisabled')}</option>
              </SelectCompat>
            </Row>
            {!draft.is_active && (
              <Row
                label={t('meetingRooms.disabledReason')}
                hint={t('meetingRooms.disabledReasonHint')}
              >
                <Input
                  value={draft.disabled_reason}
                  aria-label={t('meetingRooms.disabledReason')}
                  onChange={(e) => set('disabled_reason', e.target.value)}
                />
              </Row>
            )}
          </Section>

          <Section
            title={t('meetingRooms.section.facilities')}
            innerRef={(el) => (sectionRefs.current.facilities = el)}
          >
            {offerableFacilities.length === 0 ? (
              <StateHint className={compactStateCls}>
                {t('meetingRooms.noFacilities')}
              </StateHint>
            ) : (
              <div className={chipRowCls}>
                {offerableFacilities.map((facility) => {
                  const on = facilityIds.includes(facility.id)
                  return (
                    <button
                      key={facility.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleFacility(facility.id)}
                      className={on ? chipOnCls : chipOffCls}
                    >
                      {facility.name}
                      {!facility.is_active && ` (${t('meetingRooms.retired')})`}
                    </button>
                  )
                })}
              </div>
            )}
          </Section>

          <Section
            title={t('meetingRooms.section.bookingLimits')}
            innerRef={(el) => (sectionRefs.current.bookingLimits = el)}
          >
            <Row
              label={t('meetingRooms.bookingScope')}
              hint={t('meetingRooms.bookingScopeHint')}
            >
              <SelectCompat
                value={draft.booking_scope}
                aria-label={t('meetingRooms.bookingScope')}
                onChange={(e) =>
                  set('booking_scope', e.target.value as BookingScope)
                }
              >
                <option value="org">{t('meetingRooms.scopeOrg')}</option>
                <option value="departments">
                  {t('meetingRooms.scopeDepartments')}
                </option>
              </SelectCompat>
            </Row>
            {draft.booking_scope === 'departments' && (
              <Row label={t('meetingRooms.bookableDepartments')}>
                <div className={deptBoxCls}>
                  {departmentsFetching && departments.length === 0 ? (
                    <StateHint className={compactStateCls} state="loading">
                      {t('meetingRooms.loading')}
                    </StateHint>
                  ) : departmentsError && departments.length === 0 ? (
                    <StateHint
                      className={compactStateCls}
                      state="error"
                      action={
                        <Button
                          variant="secondary"
                          size="dense"
                          onPress={() => void refetchDepartments()}
                        >
                          {t('feedback.retry')}
                        </Button>
                      }
                    >
                      {t('feedback.loadFailed')}
                    </StateHint>
                  ) : departments.length === 0 ? (
                    <StateHint className={compactStateCls}>
                      {t('meetingRooms.noDepartments')}
                    </StateHint>
                  ) : (
                    departments.map((d) => (
                      <Checkbox
                        key={d.id}
                        size="sm"
                        className={deptCheckboxCls}
                        isSelected={draft.bookable_department_ids.includes(
                          d.id
                        )}
                        onChange={(isSelected) =>
                          set(
                            'bookable_department_ids',
                            isSelected
                              ? [...draft.bookable_department_ids, d.id]
                              : draft.bookable_department_ids.filter(
                                  (id) => id !== d.id
                                )
                          )
                        }
                      >
                        {d.name}
                      </Checkbox>
                    ))
                  )}
                </div>
              </Row>
            )}
            <Row
              label={t('meetingRooms.maxBookingMinutes')}
              hint={t('meetingRooms.limitEmptyHint')}
            >
              <Input
                type="number"
                min={15}
                max={1440}
                value={draft.max_booking_minutes}
                aria-label={t('meetingRooms.maxBookingMinutes')}
                onChange={(e) => set('max_booking_minutes', e.target.value)}
              />
            </Row>
            <Row
              label={t('meetingRooms.advanceBookingDays')}
              hint={t('meetingRooms.limitEmptyHint')}
            >
              <Input
                type="number"
                min={1}
                max={730}
                value={draft.advance_booking_days}
                aria-label={t('meetingRooms.advanceBookingDays')}
                onChange={(e) => set('advance_booking_days', e.target.value)}
              />
            </Row>
          </Section>
        </div>
      </div>

      <footer className={footerCls}>
        {save.isSuccess && !save.isPending && (
          <span className={savedCls}>{t('meetingRooms.saved')}</span>
        )}
        <Button variant="secondary" size="sm" onPress={onBack}>
          {t('actions.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          isDisabled={
            !draft.code.trim() || !draft.floor.trim() || save.isPending
          }
          loading={save.isPending}
          onPress={submit}
          data-testid="admin-mr-detail-save"
        >
          {t('actions.save')}
        </Button>
      </footer>
    </div>
  )
}

const Section = ({
  title,
  innerRef,
  children,
}: {
  title: string
  innerRef: (el: HTMLElement | null) => void
  children: ReactNode
}) => (
  <section ref={innerRef} className={sectionCls}>
    <h3 className={sectionTitleCls}>{title}</h3>
    {children}
  </section>
)

const Row = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) => (
  <div className={rowCls}>
    <span className={labelCls}>
      {label}
      {hint && <span className={hintSmallCls}>{hint}</span>}
    </span>
    <div className={css({ minWidth: 0 })}>{children}</div>
  </div>
)

const wrapCls = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
})
const detailStateCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'sm',
})
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  marginBottom: '0.875rem',
})
const roomTitleCls = css({
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const roomSubtitleCls = css({ fontSize: '0.8125rem', color: 'greyscale.500' })
const columnsCls = css({
  flex: 1,
  display: 'flex',
  gap: '1.5rem',
  minHeight: 0,
})
const railCls = css({
  flexShrink: 0,
  width: '9rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  borderRight: '1px solid token(colors.greyscale.100)',
  paddingRight: '0.5rem',
})
const railItemBase = {
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  paddingX: '0.5rem',
  paddingY: '0.375rem',
  borderRadius: '0.375rem',
  fontSize: '0.8125rem',
  cursor: 'pointer',
} as const
const railItemCls = css({
  ...railItemBase,
  color: 'greyscale.600',
  _hover: { backgroundColor: 'greyscale.100' },
})
const railItemActiveCls = css({
  ...railItemBase,
  color: 'selected.text',
  backgroundColor: 'selected.bg',
  fontWeight: '600',
})
const scrollCls = css({
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  paddingRight: '0.5rem',
})
const sectionCls = css({ marginBottom: '1.5rem', scrollMarginTop: '0.5rem' })
const sectionTitleCls = css({
  fontSize: '0.875rem',
  fontWeight: '600',
  color: 'greyscale.800',
  marginBottom: '0.75rem',
  paddingBottom: '0.375rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const rowCls = css({
  display: 'grid',
  gridTemplateColumns: '9rem minmax(0, 22rem)',
  alignItems: 'start',
  gap: '0.75rem',
  marginBottom: '0.75rem',
})
const labelCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  display: 'flex',
  flexDirection: 'column',
  paddingTop: '0.375rem',
})
const hintSmallCls = css({ fontSize: '0.6875rem', color: 'greyscale.400' })
const readOnlyCls = css({
  fontSize: '0.875rem',
  color: 'greyscale.800',
  display: 'inline-block',
  paddingTop: '0.375rem',
})
const descriptionInputCls = css({ resize: 'vertical' })
const deptBoxCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  maxHeight: '11rem',
  overflowY: 'auto',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '4px',
  padding: '0.375rem',
})
const deptCheckboxCls = css({
  paddingY: '0.125rem',
  textStyle: 'bodyMedium',
  color: 'text.primary',
})
const compactStateCls = css({
  alignItems: 'flex-start',
  padding: 'sm',
  textAlign: 'left',
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
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const savedCls = css({
  marginRight: 'auto',
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
