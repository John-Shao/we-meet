import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { WorkRoute } from './WorkRoute'

it('creates, advances and accepts a mock Work task', () => {
  render(<WorkRoute />)
  expect(screen.getByRole('heading', { name: '工作' })).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText('目标'), {
    target: { value: '整理本周进展与风险' },
  })
  fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
  expect(screen.getAllByText('整理本周进展与风险').length).toBeGreaterThan(0)
  expect(screen.getAllByText('排队中').length).toBeGreaterThan(0)

  fireEvent.click(screen.getByRole('button', { name: '模拟执行' }))
  expect(screen.getAllByText('进行中').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '模拟执行' }))
  expect(screen.getAllByText('待验收').length).toBeGreaterThan(0)
  expect(screen.getByText(/v1 · Markdown/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '采纳' }))
  expect(screen.getAllByText('已完成').length).toBeGreaterThan(0)
})

it('switches task views and shows the inbox projection', () => {
  render(<WorkRoute />)
  fireEvent.click(screen.getByRole('button', { name: '待处理' }))
  expect(screen.getByText('这个视图里还没有工作。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '待验收' }))
  expect(screen.getAllByText('季度复盘与下季度计划').length).toBeGreaterThan(0)
})
