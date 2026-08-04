import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { Switch } from '@/primitives/Switch'
import { useConfirm } from '@/components/ConfirmProvider'
import { useUser } from '@/features/auth'
import { MeetingRoomField } from '@/features/meeting-rooms'
import type { MeetingRoomBrief } from '@/features/meeting-rooms'

import { createCalendarEvent, updateCalendarEvent } from '../api/fetchCalendar'
import type { CalendarEvent, EditScope } from '../api/ApiCalendar'
import {
  REMINDER_OPTIONS,
  effectiveReminder,
  reminderOptionLabel,
  useCalendarSettings,
} from '../hooks/useCalendarSettings'
import { AttendeePicker } from './AttendeePicker'
import { fieldCls, inputCls, labelCls } from './formStyles'

interface Props {
  onCreated: (event: CalendarEvent) => void
  onClose: () => void
  /** Prefill when opened from a grid slot click (飞书式快捷创建). Falls back
   * to "next full hour, 1h long" when omitted (top-bar 新建日程). */
  initialStart?: Date
  initialEnd?: Date
  initialAllDay?: boolean
  /** P8:预选参与者 id→label(IM 会话日历抽屉把会话成员带进来);仅创建态。 */
  initialSelected?: Map<string, string>
  /** P8:来源会话 cid —— 随创建落库,变更/取消时后端向该会话推卡片。 */
  sourceConversationId?: string
  /** When set, the dialog edits this event (PATCH) instead of creating one.
   * P8:非重复日程的编辑态同样可增删参与者(attendee_ids 全量同步);
   * 重复日程编辑仍为标量字段(服务端三选路径剔除 attendee_ids)。 */
  editEvent?: CalendarEvent
  /** P2-M2:重复子场次的编辑范围(one/following/all),随 PATCH 提交。 */
  editScope?: EditScope
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Date → "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> (local time). */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
/** "YYYY-MM-DDTHH:MM" → its date portion "YYYY-MM-DD" (for <input type="date">). */
const dateOnly = (v: string) => v.slice(0, 10)

const defaultStart = () => {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

export const CreateEventDialog = ({
  onCreated,
  onClose,
  initialStart,
  initialEnd,
  initialAllDay,
  initialSelected,
  sourceConversationId,
  editEvent,
  editScope,
}: Props) => {
  const { t } = useTranslation('calendar')
  // P8 日历设置:新建态的默认时长/默认提醒从本地设置读(编辑态用事件自身值)。
  const { defaultDurationMin, defaultReminderMin } = useCalendarSettings()
  const isEdit = !!editEvent
  const start0 = editEvent
    ? new Date(editEvent.start_at)
    : (initialStart ?? defaultStart())
  const end0 = editEvent
    ? new Date(editEvent.end_at)
    : (initialEnd ?? new Date(start0.getTime() + defaultDurationMin * 60_000))

  const [title, setTitle] = useState(editEvent?.title ?? '')
  const [description, setDescription] = useState(editEvent?.description ?? '')
  const [start, setStart] = useState(toLocalInput(start0))
  const [end, setEnd] = useState(toLocalInput(end0))
  // 全天由入口决定,表单里不再给开关:周/月视图的全天行点击创建时带
  // initialAllDay 进来,编辑既有全天日程时沿用它自己的值(保存原样回传)。
  const allDay = editEvent?.all_day ?? initialAllDay ?? false
  // 提醒是「一场日程一条」的单选(null = 不提醒),与 App 端 ReminderDropdown
  // 同口径。后端 push_due_reminders 本来就只按 max(reminders) 推一次,多选
  // 复选框是张空头支票 —— 勾两档也只会到最早那档才响,故收敛成单选。
  // 编辑历史多值数据时取 effectiveReminder(= max),即真正会响的那一条。
  const [reminder, setReminder] = useState<number | null>(() =>
    editEvent ? effectiveReminder(editEvent.reminders) : defaultReminderMin
  )
  // 标准档位 + 历史数据里的非标准值(45 分钟这种),免得下拉选不中当前值。
  const reminderOptions = useMemo(() => {
    const presets = REMINDER_OPTIONS as readonly number[]
    const seed = editEvent
      ? effectiveReminder(editEvent.reminders)
      : defaultReminderMin
    const extra = seed != null && !presets.includes(seed) ? [seed] : []
    return [...presets, ...extra].sort((a, b) => a - b)
    // defaultReminderMin 只作为初值种子,设置页改动不重排已打开的表单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEvent])
  // P2-M1 重复日程:创建时可选预设;编辑重复规则属 M2 三选语义,编辑态不展示。
  const [repeat, setRepeat] = useState('')
  const [repeatUntil, setRepeatUntil] = useState('')
  // P8 编辑增删参与者:非重复日程编辑态放开参与者选择(全量同步语义);
  // 重复日程的三选路径服务端剔除 attendee_ids,故 UI 也不展示。
  const attendeesEditable =
    !editEvent || (!editEvent.recurrence && !editEvent.recurrence_parent)
  const [selected, setSelected] = useState<Map<string, string>>(() => {
    if (editEvent) {
      // 编辑态预填现有参与者(组织者恒在,不进列表、不可被移除)。
      return new Map(
        editEvent.attendees.flatMap((a) =>
          a.role !== 'organizer' && a.id
            ? [[a.id, a.full_name || a.email || '?'] as [string, string]]
            : []
        )
      )
    }
    return new Map(initialSelected ?? [])
  })
  // 编辑态把现有参与者的头像带给选人组件 —— selected 只有 id→名字,
  // 不给头像的话已选行会退成字母色块。
  const initialAvatars = useMemo(
    () =>
      new Map(
        (editEvent?.attendees ?? []).flatMap((a) =>
          a.id && a.avatar_url ? [[a.id, a.avatar_url] as [string, string]] : []
        )
      ),
    [editEvent]
  )
  const [busy, setBusy] = useState(false)
  // 视频会议(对标飞书:可移除的一项,而非日程的固有属性)。创建默认开;
  // 编辑态按事件当前有没有房间预填。
  const [withVideo, setWithVideo] = useState(
    editEvent ? editEvent.room !== null : true
  )
  // 重复日程的系列级编辑不放开该字段(服务端三选路径会剔除),与参与者同档。
  const videoEditable = attendeesEditable
  // P9 会议室:编辑态从事件预填;`roomConflicted` 是客户端预判(服务端 409
  // 才是权威),用来提前禁用提交并就地解释原因。
  const [meetingRoom, setMeetingRoom] = useState<MeetingRoomBrief | null>(
    editEvent?.meeting_room ?? null
  )
  const [roomConflicted, setRoomConflicted] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const { alert: showAlert } = useConfirm()
  // P2-M3 忙闲条:发起人自己也占一行。
  const { user } = useUser()

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate =
    !!title.trim() && !!start && !!end && !busy && !roomConflicted

  // RRULE 组装:UNTIL 用「浮动本地时刻」(无 Z 后缀)——与后端按事件时区的
  // 墙上钟展开一致,且 dateutil 在 naive dtstart 下拒绝 UTC(Z)形式的 UNTIL。
  const composeRRule = () => {
    if (!repeat) return ''
    let rule =
      repeat === 'WEEKDAYS'
        ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
        : `FREQ=${repeat}`
    if (repeatUntil) rule += `;UNTIL=${repeatUntil.replace(/-/g, '')}T235959`
    return rule
  }

  const submit = async () => {
    if (!canCreate) return
    let startDate: Date
    let endDate: Date
    if (allDay) {
      // All-day: pin to local midnight and make the end the exclusive
      // next-midnight of the chosen end day, so a single-day all-day event
      // still spans a full 24h instead of the arbitrary picker time-of-day.
      startDate = new Date(`${dateOnly(start)}T00:00`)
      endDate = new Date(`${dateOnly(end)}T00:00`)
      endDate.setDate(endDate.getDate() + 1)
    } else {
      startDate = new Date(start)
      endDate = new Date(end)
    }
    if (endDate <= startDate) {
      void showAlert({ message: t('form.endAfterStart') })
      return
    }
    setBusy(true)
    try {
      const base = {
        title: title.trim(),
        description: description.trim(),
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        all_day: allDay,
        reminders: reminder == null ? [] : [reminder],
        // P9 会议室:'' = 不预订 / 清空既有预订。刻意用空串而不是 null,
        // 好让 Android(Moshi 不序列化 null)能表达同一个意思;后端两者都收。
        // 全天日程不带该字段 —— M1 不支持全天订会议室。
        ...(allDay ? {} : { meeting_room_id: meetingRoom?.id ?? '' }),
        // 创建时总是明说;编辑时只在可改的场景下带上(重复日程系列级不传,
        // 让服务端保持原样)。
        ...(videoEditable ? { with_video_meeting: withVideo } : {}),
      }
      const event = editEvent
        ? await updateCalendarEvent(editEvent.id, {
            // P2-M2:重复子场次带三选范围;单次/主事件不带(主=服务端全部)。
            ...(editScope ? { ...base, edit_scope: editScope } : base),
            // P8:非重复日程编辑同步参与者(全量);重复日程不传。
            ...(attendeesEditable
              ? { attendee_ids: [...selected.keys()] }
              : {}),
          })
        : await createCalendarEvent({
            ...base,
            attendee_ids: [...selected.keys()],
            recurrence: composeRRule(),
            ...(sourceConversationId
              ? { source_conversation_id: sourceConversationId }
              : {}),
          })
      onCreated(event)
    } catch (e) {
      void showAlert({
        message: t('form.error', { message: apiErrorMessage(e) }),
      })
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('form.title')}
      initialFocusRef={titleRef}
      maxWidth="560px"
      maxHeight="82vh"
    >
      <div className={headerCls}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {isEdit ? t('form.editTitle') : t('form.title')}
        </h2>
        <ModalCloseButton onClose={onClose} label={t('form.cancel')} />
      </div>

      <div
        className={css({
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.875rem',
        })}
      >
        <input
          ref={titleRef}
          type="text"
          value={title}
          maxLength={255}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('form.titlePlaceholder')}
          data-testid="event-title"
          className={inputCls}
        />

        <textarea
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('form.descriptionPlaceholder')}
          rows={3}
          data-testid="event-description"
          className={textareaCls}
        />

        <div
          className={css({
            display: 'flex',
            gap: '0.75rem',
            flexWrap: 'wrap',
          })}
        >
          <label className={fieldCls}>
            <span className={labelCls}>{t('form.start')}</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? dateOnly(start) : start}
              onChange={(e) => {
                const v = e.target.value
                setStart(allDay ? (v ? `${v}T00:00` : '') : v)
              }}
              data-testid="event-start"
              className={inputCls}
            />
          </label>
          <label className={fieldCls}>
            <span className={labelCls}>{t('form.end')}</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? dateOnly(end) : end}
              onChange={(e) => {
                const v = e.target.value
                setEnd(allDay ? (v ? `${v}T00:00` : '') : v)
              }}
              data-testid="event-end"
              className={inputCls}
            />
          </label>
        </div>

        {/* 提醒 —— 与下面的「重复」同构(标签 + 满宽 select)。原来它和「全天」
            复选框挤在一行,select 一撑就把「全天」挤到下一行去,布局散架。 */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.75rem',
            fontSize: '0.875rem',
            color: 'greyscale.800',
          })}
        >
          <span>{t('form.reminder')}</span>
          <select
            value={reminder == null ? '' : String(reminder)}
            onChange={(e) =>
              setReminder(e.target.value === '' ? null : Number(e.target.value))
            }
            data-testid="event-reminder"
            className={cx(inputCls, selectChrome)}
          >
            <option value="">{t('form.reminderNone')}</option>
            {reminderOptions.map((m) => (
              <option key={m} value={String(m)}>
                {reminderOptionLabel(t, m)}
              </option>
            ))}
          </select>
        </div>

        {/* P2-M1 重复 — 创建时可选;编辑重复规则属 M2 三选语义,编辑态隐藏。 */}
        {!isEdit && (
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              fontSize: '0.875rem',
              color: 'greyscale.800',
            })}
          >
            <span>{t('form.repeat')}</span>
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              data-testid="event-repeat"
              className={cx(inputCls, selectChrome)}
            >
              <option value="">{t('form.repeatNone')}</option>
              <option value="DAILY">{t('form.repeatDaily')}</option>
              <option value="WEEKDAYS">{t('form.repeatWeekdays')}</option>
              <option value="WEEKLY">{t('form.repeatWeekly')}</option>
              <option value="MONTHLY">{t('form.repeatMonthly')}</option>
            </select>
            {repeat && (
              <label
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                })}
              >
                {t('form.repeatUntil')}
                <input
                  type="date"
                  value={repeatUntil}
                  onChange={(e) => setRepeatUntil(e.target.value)}
                  data-testid="event-repeat-until"
                  className={inputCls}
                />
              </label>
            )}
          </div>
        )}

        {/* Attendees — 创建态 + 非重复日程编辑态(P8 全量同步);重复日程编辑不展示。 */}
        {attendeesEditable && (
          <div>
            {/* 选人区:标题/计数/「添加」按钮与已选列表都由它自己渲染。 */}
            <AttendeePicker
              selected={selected}
              onToggle={toggle}
              initialAvatars={initialAvatars}
              slotStart={!allDay && start ? new Date(start) : null}
              slotEnd={!allDay && end ? new Date(end) : null}
              excludeEventId={editEvent?.id}
              selfId={user?.id}
            />
          </div>
        )}

        {/* 视频会议 —— 对标飞书,是一项「可以移除」的东西而不是日程的固有
            属性。放在会议室之前:两者都是「在哪开」,线上先于线下。 */}
        {videoEditable && (
          <div data-testid="event-video-meeting">
            {/* 开/关是个布尔状态,用胶囊开关而不是「移除/添加」文字按钮 ——
                与 App 端同款,也省掉「按钮上写的是当前态还是下一步动作」的歧义。 */}
            <Switch
              isSelected={withVideo}
              onChange={setWithVideo}
              data-testid="event-video-toggle"
              className={videoSwitchCls}
            >
              <span className={labelCls}>{t('form.videoMeeting')}</span>
            </Switch>
            <div className={videoHintCls}>
              {withVideo ? t('form.videoMeetingOn') : t('form.videoMeetingOff')}
            </div>
          </div>
        )}

        {/* P9 会议室 —— 放在参与者之后:容量筛选按已选人数起算,可用性依赖
            上方选好的时段,冲突提示条也就正好压在提交按钮上方。 */}
        <MeetingRoomField
          value={meetingRoom}
          onChange={setMeetingRoom}
          start={
            start ? new Date(allDay ? `${dateOnly(start)}T00:00` : start) : null
          }
          end={end ? new Date(allDay ? `${dateOnly(end)}T00:00` : end) : null}
          allDay={allDay}
          attendeeCount={selected.size + 1}
          excludeEventId={editEvent?.id}
          onConflictChange={setRoomConflicted}
        />
      </div>

      <div
        className={css({
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.5rem',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          isDisabled={!canCreate}
          onPress={submit}
          data-testid="event-create"
        >
          {isEdit ? t('form.save') : t('form.create')}
        </Button>
      </div>
    </Modal>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const textareaCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  outline: 'none',
  resize: 'vertical',
  minHeight: '3.5rem',
  _focus: { borderColor: 'primary.500' },
})

// 标签在左、开关在右(Switch 默认滑块在前,故 row-reverse)。
const videoSwitchCls = css({
  width: '100%',
  flexDirection: 'row-reverse',
  justifyContent: 'space-between',
})
const videoHintCls = css({
  marginTop: '0.125rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
