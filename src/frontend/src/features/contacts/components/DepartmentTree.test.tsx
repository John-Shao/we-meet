import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryDepartment } from '../api/ApiDirectory'
import { DepartmentTree } from './DepartmentTree'

// t() 回显 key(带 count 时把数字也带上),断言就能同时验到「用了哪个词条」和数值。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count === undefined ? key : `${key}:${opts.count}`,
  }),
}))

const dept = (
  id: string,
  name: string,
  parent: string | null,
  memberCount = 0
): DirectoryDepartment => ({
  id,
  name,
  parent,
  path: `/${id}/`,
  depth: parent ? 1 : 0,
  head: null,
  sort_order: 0,
  code: id,
  member_count: memberCount,
})

// 销售部 → 华东大区 → 上海团队(两层祖先,专门用来验「选中时自动展开祖先链」)
const departments = [
  dept('sales', '销售部', null, 4),
  dept('east', '华东大区', 'sales', 3),
  dept('sh', '上海团队', 'east', 2),
  dept('hr', '人力资源部', null, 5),
]

const row = (id: string) => screen.getByTestId(`contacts-dept-${id}`)

beforeEach(() => {
  sessionStorage.clear()
})

describe('DepartmentTree', () => {
  it('默认收起:只渲染一级部门,人数显示在节点右侧', () => {
    render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
      />
    )
    expect(row('sales')).toBeInTheDocument()
    expect(row('hr')).toBeInTheDocument()
    // 子层级收着 —— 这是树的默认形态,不是丢数据。
    expect(screen.queryByTestId('contacts-dept-east')).toBeNull()
    expect(screen.queryByTestId('contacts-dept-sh')).toBeNull()
    expect(row('sales')).toHaveTextContent('page.count:4')
    expect(row('sales')).toHaveAttribute('aria-expanded', 'false')
    expect(row('sales')).toHaveAttribute('aria-level', '1')
  })

  it('选中深层部门时自动展开它的整条祖先链', () => {
    render(
      <DepartmentTree
        departments={departments}
        selectedId="sh"
        onSelect={vi.fn()}
      />
    )
    // 三层全部可见,且层级语义正确 —— 否则选中的那一行根本不在屏幕上。
    expect(row('sh')).toHaveAttribute('aria-level', '3')
    expect(row('sh')).toHaveAttribute('aria-selected', 'true')
    expect(row('east')).toHaveAttribute('aria-expanded', 'true')
    expect(row('sales')).toHaveAttribute('aria-expanded', 'true')
  })

  it('箭头按钮的标签走 i18n(以前硬编码英文 expand/collapse)', () => {
    render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
      />
    )
    expect(
      screen.getByTestId('contacts-dept-toggle-sales')
    ).toHaveAccessibleName('tree.expand')
    expect(screen.queryByTestId('contacts-dept-toggle-hr')).toBeNull() // 没有子部门就不给箭头
  })

  it('筛选:命中项与它的祖先都留下,其它分支消失', () => {
    const { rerender } = render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
        filter="上海"
      />
    )
    expect(row('sh')).toBeInTheDocument()
    expect(row('sales')).toBeInTheDocument() // 祖先,作为路径保留
    expect(screen.queryByTestId('contacts-dept-hr')).toBeNull()

    rerender(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
        filter="不存在的部门"
      />
    )
    expect(screen.getByTestId('contacts-dept-no-match')).toHaveTextContent(
      'page.noDeptMatch'
    )
  })

  it('键盘:右键展开、左键先回父级再收起、上下键移动', async () => {
    const user = userEvent.setup()
    render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
      />
    )
    await user.tab()
    expect(row('sales')).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(row('east')).toBeInTheDocument()

    await user.keyboard('{ArrowDown}')
    expect(row('east')).toHaveFocus()

    // 华东大区自己没收起(它本来也没展开)→ 左键按规范先回父级。
    await user.keyboard('{ArrowLeft}')
    expect(row('east')).toBeInTheDocument()
    expect(row('sales')).toHaveFocus()

    // 父级是展开的 → 再按左键才收起整枝。
    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByTestId('contacts-dept-east')).toBeNull()
    expect(row('sales')).toHaveFocus()
  })

  it('展开态写进 sessionStorage,切走再回来还是展开的', async () => {
    const user = userEvent.setup()
    render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByTestId('contacts-dept-toggle-sales'))
    expect(
      JSON.parse(
        sessionStorage.getItem('we-meet:contacts-dept-expanded') ?? '[]'
      )
    ).toContain('sales')
  })

  it('点名字是选中(不是展开),点箭头只展开', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <DepartmentTree
        departments={departments}
        selectedId={null}
        onSelect={onSelect}
      />
    )
    await user.click(row('sales'))
    expect(onSelect).toHaveBeenCalledWith('sales')
    // 点名字不该顺手展开。
    expect(screen.queryByTestId('contacts-dept-east')).toBeNull()

    await user.click(screen.getByTestId('contacts-dept-toggle-sales'))
    expect(screen.getByTestId('contacts-dept-east')).toBeInTheDocument()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
