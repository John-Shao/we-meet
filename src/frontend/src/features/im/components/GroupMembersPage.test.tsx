import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { GroupMembersPage } from './GroupMembersPage'

/**
 * 群成员名单的**刻画测试** —— 写在把名单搬进二级页 (`GroupMembersPage`) 之前。
 *
 * 为什么先写:`group-add-members` / `member-kick-*` / `member-transfer-*` /
 * `group-member-search` 这些 testid 全仓只在 `GroupInfoPanel.tsx` 自身出现,
 * 没有 e2e、没有单测引用 —— 也就是说这块**一点兜底都没有**,搬错了看不出来。
 *
 * 怎么用它证明「一比一搬过去」:下面 6 条断言在搬运前后**一个字都不改**,
 * 唯一会动的是 [mountRoster] 的函数体(换挂载的组件)。commit 1「纯搬运」的
 * 判据因此从「这几百行对不对」降级成「这个文件除了 mountRoster 是否零 diff」。
 *
 * t 被 mock 成原样返回 key:断言的是结构不是文案,换个措辞不该弄红测试。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ConfirmProvider', () => ({
  useConfirm: () => ({
    confirm: async () => false,
    alert: async () => {},
  }),
}))

// vi.mock 的工厂会被提升到文件顶部,不能闭包捕获下面用 const 声明的变量,
// 所以目录快照走 vi.hoisted。
const { directory } = vi.hoisted(() => ({
  directory: {} as Record<
    string,
    { id: string; full_name: string; avatar_url?: string; left?: boolean }
  >,
}))

vi.mock('../api/resolveImUsers', () => ({
  resolveImUsers: async (uids: string[]) =>
    Object.fromEntries(
      uids.filter((u) => u in directory).map((u) => [u, directory[u]]),
    ),
}))

interface Person {
  uid: string
  /** 目录名(we-meet 侧)。 */
  name?: string
  /** 群昵称(jusi roster 侧),应当盖过目录名。 */
  nickname?: string
  /** roster 里的 role —— 刻意可以与 `ownerUid` 不一致,见「群主徽章」那条。 */
  role?: string
  left?: boolean
}

/** 这个人在名单上应该显示成什么(群昵称 > 目录名 > uid,与 `nameOf` 同口径)。 */
const labelOf = (p: Person) => p.nickname ?? p.name ?? `dir:${p.uid}`

/**
 * **本文件唯一会随搬运改动的地方。**
 * 搬运后这里改成挂 `GroupMembersPage`,6 条断言原封不动。
 */
const mountRoster = async ({
  people,
  ownerUid,
  currentUserUID = ownerUid,
}: {
  people: Person[]
  ownerUid: string
  currentUserUID?: string
}) => {
  for (const key of Object.keys(directory)) delete directory[key]
  for (const p of people) {
    directory[p.uid] = {
      id: `pk-${p.uid}`,
      full_name: p.name ?? `dir:${p.uid}`,
      ...(p.left ? { left: true } : {}),
    }
  }

  const roster = people.map((p) => ({
    uid: p.uid,
    role: p.role ?? 'member',
    joined_at: 0,
    ...(p.nickname ? { nickname: p.nickname } : {}),
  }))

  const client = {
    listMembers: async () => roster,
    onConversation: () => () => {},
  } as unknown as Client

  const conversation = {
    cid: 'c-test',
    type: 'group',
    name: '测试群',
    owner_uid: ownerUid,
    members: people.map((p) => p.uid),
  } as unknown as ConversationSummary

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GroupMembersPage
        client={client}
        conversation={conversation}
        currentUserUID={currentUserUID}
        onAddMembers={() => {}}
      />
    </QueryClientProvider>,
  )

  // 等最后一行的**显示名**出现,而不是等成员计数 —— roster 的初值是 [],
  // 「manage.members (0)」一挂载就在,等它等于没等。显示名同时压着两个异步
  // query(roster 拿 nickname、resolve 拿目录名),它出来了才是真渲染完。
  await screen.findByText(labelOf(people[people.length - 1]))
}

describe('群成员名单', () => {
  it('成员计数与行数都来自 roster', async () => {
    await mountRoster({
      people: [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }],
      ownerUid: 'a',
    })

    expect(screen.getByText(/^manage\.members \(3\)$/)).toBeInTheDocument()
    expect(screen.getAllByText(/^dir:/)).toHaveLength(3)
  })

  it('10 人不出搜索框,11 人才出', async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ uid: `u${i}` }))

    await mountRoster({ people: mk(10), ownerUid: 'u0' })
    expect(screen.queryByTestId('group-member-search')).not.toBeInTheDocument()

    cleanup()
    await mountRoster({ people: mk(11), ownerUid: 'u0' })
    expect(screen.getByTestId('group-member-search')).toBeInTheDocument()
  })

  it('群主徽章认 owner_uid,不认 roster 里滞后的 role', async () => {
    // 转让之后 roster 的 role 会滞后一次同步,owner_uid 才是权威。
    await mountRoster({
      people: [
        { uid: 'stale', name: '旧群主', role: 'owner' },
        { uid: 'real', name: '新群主' },
      ],
      ownerUid: 'real',
    })

    // getByText 单数:徽章只能有一个。
    expect(screen.getByText('manage.owner').closest('li')).toHaveTextContent(
      '新群主',
    )
  })

  it('离职成员挂中性 chip', async () => {
    await mountRoster({
      people: [
        { uid: 'a', name: '在职的' },
        { uid: 'b', name: '离职的', left: true },
      ],
      ownerUid: 'a',
    })

    expect(screen.getByText('departed.chip').closest('li')).toHaveTextContent(
      '离职的',
    )
  })

  it('转让/移除只给群主,且不出现在群主自己那行', async () => {
    const people = [{ uid: 'owner' }, { uid: 'other' }]

    await mountRoster({ people, ownerUid: 'owner', currentUserUID: 'other' })
    expect(screen.queryByTestId('member-transfer-owner')).not.toBeInTheDocument()
    expect(screen.queryByTestId('member-kick-owner')).not.toBeInTheDocument()

    cleanup()
    await mountRoster({ people, ownerUid: 'owner', currentUserUID: 'owner' })
    expect(screen.getByTestId('member-transfer-other')).toBeInTheDocument()
    expect(screen.getByTestId('member-kick-other')).toBeInTheDocument()
    // 自己那行(同时也是群主行)不给按钮 —— 免得把群主转给自己 / 把自己踢了。
    expect(screen.queryByTestId('member-kick-owner')).not.toBeInTheDocument()
  })

  it('群昵称盖过目录名', async () => {
    // 带昵称的这个人**不要用自己** —— 这条断言刚写出来时挂的还是整块
    // GroupInfoPanel,自己的群昵称同时出现在名单行和 root 的「我的群昵称」
    // 那一行,一个字符串命中两处。那正是 myNickname 与名单同源的证据,
    // 也是 root 至今仍要挂 useGroupRoster 的原因。
    await mountRoster({
      people: [
        { uid: 'me', name: '我自己' },
        { uid: 'a', name: '目录里的名字', nickname: '群里的昵称' },
      ],
      ownerUid: 'me',
    })

    expect(screen.getByText('群里的昵称')).toBeInTheDocument()
    expect(screen.queryByText('目录里的名字')).not.toBeInTheDocument()
  })
})
