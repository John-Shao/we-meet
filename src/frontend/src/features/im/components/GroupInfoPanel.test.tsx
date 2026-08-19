import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { GroupInfoPanel } from './GroupInfoPanel'
import { updateGroupMeta } from '../api/updateGroupMeta'

/**
 * 群面板三处行内编辑(群名 / 群公告 / 群昵称)的**无按钮**契约。
 *
 * 只钉「点铅笔 → 只有输入框(没有保存/取消按钮)+ Enter/Esc/失焦 的行为」,
 * 以及 Esc 只退编辑态、不关面板。状态机边界已在 `useInlineEdit.test.tsx` 钉过,
 * 这里验证的是 GroupInfoPanel 的接线(ref / testid / onSave 参数 / Esc 冒泡)。
 *
 * t 被 mock 成原样返回 key:断言结构不文案。
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

vi.mock('../api/updateGroupMeta', () => ({
  updateGroupMeta: vi.fn(async () => ({})),
}))

vi.mock('../api/groupBots', () => ({
  listGroupBots: vi.fn(async () => []),
}))

vi.mock('../api/resolveImUsers', () => ({
  resolveImUsers: vi.fn(async () => ({})),
}))

vi.mock('../api/announceLeave', () => ({
  announceLeave: vi.fn(async () => {}),
}))

const mount = async () => {
  const client = {
    listMembers: async () => [
      { uid: 'me', role: 'owner', nickname: '我的昵称', joined_at: 0 },
      { uid: 'a', role: 'member', joined_at: 0 },
    ],
    onConversation: () => () => {},
    setConversationSettings: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => {}),
    leaveConversation: vi.fn(async () => {}),
  } as unknown as Client

  const conversation = {
    cid: 'c-test',
    type: 'group',
    name: '测试群',
    owner_uid: 'me',
    members: ['me', 'a'],
    meta: { description: '原公告' },
  } as unknown as ConversationSummary

  const onClose = vi.fn()
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GroupInfoPanel
        client={client}
        conversation={conversation}
        currentUserUID="me"
        onAddMembers={() => {}}
        onLeft={() => {}}
        onOpenCalendar={() => {}}
        onClose={onClose}
      />
    </QueryClientProvider>
  )

  await screen.findByTestId('group-rename')
  return { client, onClose }
}

describe('群面板的无按钮行内编辑', () => {
  it('群名:点铅笔只有输入框(无按钮),Enter 保存', async () => {
    await mount()

    fireEvent.click(screen.getByTestId('group-rename'))
    const input = screen.getByTestId('group-rename-input')
    expect(input).toHaveValue('测试群')
    expect(screen.queryByText('manage.save')).not.toBeInTheDocument()
    expect(screen.queryByText('manage.cancel')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '新群名' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(updateGroupMeta).toHaveBeenCalledWith('c-test', {
        name: '新群名',
        description: '原公告',
        kind: 'rename',
      })
    )
    await waitFor(() =>
      expect(screen.queryByTestId('group-rename-input')).not.toBeInTheDocument()
    )
  })

  it('群公告:点铅笔只有多行输入框,Esc 退出且不关面板', async () => {
    const { onClose } = await mount()

    fireEvent.click(screen.getByTestId('group-desc-edit'))
    const textarea = screen.getByTestId('group-desc-input')
    expect(textarea).toHaveValue('原公告')
    expect(screen.queryByText('manage.save')).not.toBeInTheDocument()
    expect(screen.queryByText('manage.cancel')).not.toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByTestId('group-desc-input')).not.toBeInTheDocument()
    // Esc 只退编辑态:stopPropagation 挡住面板级 Esc 监听。
    expect(onClose).not.toHaveBeenCalled()
  })

  it('群昵称:点铅笔只有输入框,失焦自动保存', async () => {
    const { client } = await mount()

    // 等 roster 把「我的群昵称」拉回来(它只来自 roster,不在 ConversationSummary)。
    await screen.findByText('我的昵称')

    fireEvent.click(screen.getByTestId('group-nick-edit'))
    const input = screen.getByTestId('group-nick-input')
    expect(input).toHaveValue('我的昵称')
    expect(screen.queryByText('manage.save')).not.toBeInTheDocument()
    expect(screen.queryByText('manage.cancel')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '新昵称' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(client.setConversationSettings).toHaveBeenCalledWith('c-test', {
        nickname: '新昵称',
      })
    )
    await waitFor(() =>
      expect(screen.queryByTestId('group-nick-input')).not.toBeInTheDocument()
    )
  })
})
