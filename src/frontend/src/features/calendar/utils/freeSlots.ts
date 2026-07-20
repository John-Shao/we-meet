/**
 * P8 共同空闲(纯函数,无 React 依赖):IM 会话日历抽屉用。
 * 输入 freebusy 端点返回的每人 busy 区间,输出「全员都有空」的建议时段。
 * 未解析成员(跨组织等)不应传入 —— 由 UI 单独提示,不参与判定。
 */

export interface BusyLike {
  start: string | Date
  end: string | Date
}

export interface PersonBusy {
  id: string
  busy: BusyLike[]
}

export interface SuggestedSlot {
  start: Date
  end: Date
}

const SLOT_MIN = 30
const WORK_START_HOUR = 9
const WORK_END_HOUR = 18
/** 距 now 不足该余量的时段不建议(马上开始/已过去)。 */
const IMMINENT_MARGIN_MIN = 15

const toDate = (d: string | Date): Date =>
  typeof d === 'string' ? new Date(d) : d

const overlaps = (
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean => aStart < bEnd && aEnd > bStart

/**
 * 所选时段与谁冲突 —— 返回忙碌成员 id 列表(空数组 = 所有参与者都有空)。
 * 直接用原始区间判定,不走 30min 网格,避免吸附误差。
 */
export const busyPeopleInRange = (
  people: PersonBusy[],
  start: Date,
  end: Date
): string[] =>
  people
    .filter((p) =>
      p.busy.some((b) => overlaps(toDate(b.start), toDate(b.end), start, end))
    )
    .map((p) => p.id)

export const isRangeFreeForAll = (
  people: PersonBusy[],
  start: Date,
  end: Date
): boolean => busyPeopleInRange(people, start, end).length === 0

/**
 * 工作时间(本地 09:00-18:00)内建议 2-3 个全员空闲时段。
 *
 * 算法:30min 网格 → 每人忙碌布尔 → 全员空闲格(今天再过滤掉 now+15min
 * 之前结束的格)→ 极大连续空闲段 → 按期望时长(默认 60min,排不下降级
 * 30min)切候选窗 → 评分(黄金时段 +2;所在段的前后冗余每 30min +1 封顶
 * +2;距 now 每小时 -0.1 使同分先近后远)→ 贪心取互不重叠的前 `limit` 个。
 */
export const suggestCommonSlots = (
  people: PersonBusy[],
  day: Date,
  opts?: {
    durationMin?: number
    limit?: number
    now?: Date
  }
): SuggestedSlot[] => {
  const durationMin = opts?.durationMin ?? 60
  const limit = opts?.limit ?? 3
  const now = opts?.now ?? new Date()

  const workStart = new Date(day)
  workStart.setHours(WORK_START_HOUR, 0, 0, 0)
  const workEnd = new Date(day)
  workEnd.setHours(WORK_END_HOUR, 0, 0, 0)
  const slotCount = Math.round(
    (workEnd.getTime() - workStart.getTime()) / (SLOT_MIN * 60_000)
  )

  const slotStart = (i: number): Date =>
    new Date(workStart.getTime() + i * SLOT_MIN * 60_000)

  // 全员空闲格。busy 判定沿用区间重叠口径(busy.start < slotEnd && busy.end > slotStart)。
  const minFreeEnd = new Date(now.getTime() + IMMINENT_MARGIN_MIN * 60_000)
  const allFree: boolean[] = []
  for (let i = 0; i < slotCount; i += 1) {
    const s = slotStart(i)
    const e = slotStart(i + 1)
    if (e <= minFreeEnd) {
      allFree.push(false) // 已过去 / 马上开始
      continue
    }
    allFree.push(busyPeopleInRange(people, s, e).length === 0)
  }

  // 极大连续空闲段 [i, j)(格下标)。
  const runs: Array<{ from: number; to: number }> = []
  let runFrom = -1
  for (let i = 0; i <= slotCount; i += 1) {
    const free = i < slotCount && allFree[i]
    if (free && runFrom < 0) runFrom = i
    if (!free && runFrom >= 0) {
      runs.push({ from: runFrom, to: i })
      runFrom = -1
    }
  }
  if (runs.length === 0) return []

  // 期望时长排不下时降级 30min。
  const longestRunMin = Math.max(...runs.map((r) => (r.to - r.from) * SLOT_MIN))
  const winSlots = Math.max(
    1,
    Math.ceil(Math.min(durationMin, longestRunMin) / SLOT_MIN)
  )

  interface Candidate extends SuggestedSlot {
    fromSlot: number
    toSlot: number
    score: number
  }
  const golden = (start: Date): boolean => {
    const h = start.getHours() + start.getMinutes() / 60
    return (h >= 10 && h < 12) || (h >= 14 && h < 17)
  }
  const candidates: Candidate[] = []
  for (const run of runs) {
    for (let s = run.from; s + winSlots <= run.to; s += 1) {
      const start = slotStart(s)
      const end = slotStart(s + winSlots)
      const surplusSlots = run.to - run.from - winSlots
      let score = 0
      if (golden(start)) score += 2
      score += Math.min(surplusSlots, 2)
      score -= ((start.getTime() - now.getTime()) / 3_600_000) * 0.1
      candidates.push({ start, end, fromSlot: s, toSlot: s + winSlots, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const picked: Candidate[] = []
  for (const c of candidates) {
    if (picked.length >= limit) break
    if (picked.some((p) => c.fromSlot < p.toSlot && c.toSlot > p.fromSlot)) {
      continue
    }
    picked.push(c)
  }
  picked.sort((a, b) => a.start.getTime() - b.start.getTime())
  return picked.map(({ start, end }) => ({ start, end }))
}
