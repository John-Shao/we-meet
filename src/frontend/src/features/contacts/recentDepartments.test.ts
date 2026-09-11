import { beforeEach, describe, expect, it } from 'vitest'

import {
  readRecentDepartments,
  rememberDepartment,
  writeRecentDepartments,
} from './recentDepartments'

const KEY = 'we-meet:contacts-recent-depts'

beforeEach(() => {
  localStorage.clear()
})

describe('recentDepartments', () => {
  it('没存过就是空的', () => {
    expect(readRecentDepartments()).toEqual([])
  })

  it('坏数据不炸,退回空数组', () => {
    localStorage.setItem(KEY, '{ not json')
    expect(readRecentDepartments()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }))
    expect(readRecentDepartments()).toEqual([])
    // 混了非字符串元素:整份丢掉比留一半更安全(不然渲染时会踩到 undefined)。
    localStorage.setItem(KEY, JSON.stringify(['a', 2]))
    expect(readRecentDepartments()).toEqual([])
  })

  it('把最近看的那个提到最前,重复的不留两份', () => {
    expect(rememberDepartment('b', ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(rememberDepartment('d', ['a', 'b'])).toEqual(['d', 'a', 'b'])
  })

  it('最多留 5 个 —— 它是快捷键,不是历史记录', () => {
    let list: string[] = []
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      list = rememberDepartment(id, list)
    }
    expect(list).toEqual(['f', 'e', 'd', 'c', 'b'])
  })

  it('写进去能原样读回来', () => {
    writeRecentDepartments(['x', 'y'])
    expect(readRecentDepartments()).toEqual(['x', 'y'])
  })

  it('不修改传进来的数组(state 更新要靠新引用)', () => {
    const current = ['a', 'b']
    rememberDepartment('c', current)
    expect(current).toEqual(['a', 'b'])
  })
})
