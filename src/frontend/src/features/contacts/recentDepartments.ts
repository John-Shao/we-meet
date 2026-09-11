/**
 * 「最近访问的部门」——左栏的一个快捷键分组。
 *
 * 存在的理由:通讯录平时只有两种用法 —— 看自己部门、看某个常打交道的部门。
 * 前者在几十个部门的树里每次都要重新找一遍。这里只记 id(名字/人数从部门树
 * 那份数据里取),所以部门被删掉后会自动从列表里消失,不需要清理逻辑。
 *
 * 存 localStorage:它是个人习惯,不是组织数据。
 */
const STORAGE_KEY = 'we-meet:contacts-recent-depts'

/** 上限 —— 这是快捷键,不是历史记录;多了反而要再看一遍。 */
const MAX_RECENT = 5

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export const readRecentDepartments = (): string[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return isStringArray(parsed) ? parsed : []
  } catch {
    // 隐私模式 / 脏数据:不记最近访问,但别的都不受影响。
    return []
  }
}

/** 把一个部门提到最前(去重 + 截断)。返回新数组,不改入参 —— 调用方拿它 setState。 */
export const rememberDepartment = (id: string, current: string[]): string[] =>
  [id, ...current.filter((item) => item !== id)].slice(0, MAX_RECENT)

export const writeRecentDepartments = (ids: string[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 同上。
  }
}
