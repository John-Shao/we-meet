import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TitleBar } from './TitleBar'

describe('TitleBar', () => {
  it('keeps title and meta on one row with the leading element first', () => {
    render(
      <TitleBar
        title="前端开发组"
        leading={<span data-testid="avatar-tile" />}
        meta="5 人"
      />
    )
    expect(screen.getByTestId('title-bar-leading')).toContainElement(
      screen.getByTestId('avatar-tile')
    )
    expect(screen.getByTestId('title-bar-title')).toHaveTextContent(
      '前端开发组'
    )
    expect(screen.getByTestId('title-bar-meta')).toHaveTextContent('5 人')
  })

  it('uses a pressable title only when a handler is given', () => {
    const onTitlePress = vi.fn()
    const view = render(<TitleBar title="我负责的" meta="5 个任务" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    view.rerender(
      <TitleBar
        title="前端开发组"
        meta="5 人"
        onTitlePress={onTitlePress}
        titleActionLabel="manage.settings"
      />
    )
    const title = screen.getByRole('button', { name: 'manage.settings' })
    fireEvent.click(title)
    expect(onTitlePress).toHaveBeenCalledOnce()
  })

  it('omits the leading and meta slots when there is nothing to show', () => {
    render(<TitleBar title="发起申请" />)
    expect(screen.queryByTestId('title-bar-leading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('title-bar-meta')).not.toBeInTheDocument()
    expect(screen.getByTestId('title-bar-title')).toHaveTextContent('发起申请')
  })

  it('renders the module actions to the right of the title row', () => {
    render(
      <TitleBar title="视频会议">
        <button type="button">快速会议</button>
      </TitleBar>
    )
    expect(screen.getByRole('button', { name: '快速会议' })).toBeInTheDocument()
  })
})
