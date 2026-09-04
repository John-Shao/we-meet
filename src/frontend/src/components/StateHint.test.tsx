import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StateHint } from './StateHint'

describe('StateHint', () => {
  it('exposes a polite busy loading state', () => {
    render(<StateHint state="loading">正在加载</StateHint>)

    const state = screen.getByRole('status')
    expect(state).toHaveAttribute('data-state', 'loading')
    expect(state).toHaveAttribute('aria-live', 'polite')
    expect(state).toHaveAttribute('aria-busy', 'true')
  })

  it('uses an assertive alert and renders the recovery action for errors', () => {
    render(
      <StateHint state="error" action={<button type="button">重试</button>}>
        加载失败
      </StateHint>
    )

    expect(screen.getByRole('alert')).toHaveAttribute('data-state', 'error')
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  })

  it('uses the empty state by default', () => {
    render(<StateHint>暂无数据</StateHint>)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'empty')
  })
})
