import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { JoinMeeting } from './JoinMeeting'
import { navigateTo } from '@/navigation/navigateTo'

/**
 * 「加入会议」从弹窗改成页面(`/meeting/join`)后,原先只活在弹窗里的那一步
 * ——**先把粘贴进来的东西归一成房间 id,再导航**——第一次有了测试。
 *
 * 值得钉住的理由:它的失效是静默的。少归一一次,用户把整条链接粘进来就会撞上
 * 一个 404 房间页,而不是"按钮没反应";而会议号在这个产品里有三种常见写法
 * (8 位数字、带空格的 8 位数字、带横线的短码)加上"整条链接"这一种粘贴方式。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/navigation/navigateTo', () => ({ navigateTo: vi.fn() }))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/features/auth', () => ({ useUser: () => ({ isLoggedIn: true }) }))
vi.mock('../components/MeetingModuleShell', () => ({
  MeetingModuleShell: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('../components/MeetingModuleNav', () => ({
  MeetingModuleNav: () => <nav aria-label="meeting-module-nav" />,
}))

const submit = (value: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'joinInputLabel' }), {
    target: { value },
  })
  fireEvent.click(screen.getByRole('button', { name: 'joinInputSubmit' }))
}

describe('加入会议页', () => {
  beforeEach(() => {
    vi.mocked(navigateTo).mockClear()
    render(<JoinMeeting />)
  })

  it('8 位会议号 → 进那个房间', () => {
    submit('12345678')
    expect(navigateTo).toHaveBeenCalledWith('room', '12345678')
  })

  it('带空格的会议号(App 历史页那种写法)也归一', () => {
    submit('1234 5678')
    expect(navigateTo).toHaveBeenCalledWith('room', '12345678')
  })

  it('粘整条链接进来 → 取其中的房间段', () => {
    submit(`${window.location.origin}/abc-defg-hij`)
    expect(navigateTo).toHaveBeenCalledWith('room', 'abc-defg-hij')
  })

  it('大写短码 → 小写', () => {
    submit('ABC-DEFG-HIJ')
    expect(navigateTo).toHaveBeenCalledWith('room', 'abc-defg-hij')
  })

  it('非法输入 → 不导航,并列出允许的几种写法', () => {
    submit('abc')
    expect(navigateTo).not.toHaveBeenCalled()
    expect(screen.getByText('joinInputError')).toBeInTheDocument()
  })
})
