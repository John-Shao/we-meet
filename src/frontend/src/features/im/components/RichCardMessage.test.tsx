import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RichCardMessage } from './RichCardMessage'

const { followMutate, state, unfollowMutate } = vi.hoisted(() => ({
  followMutate: vi.fn(),
  state: { isFollowing: false },
  unfollowMutate: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'followers.cardFollowing' ? '已关注' : '关注'),
  }),
}))

vi.mock('@/features/tasks/api/fetchTasks', () => ({
  useTask: (taskId: string) => ({
    data: { id: taskId, is_following: state.isFollowing },
    isLoading: false,
    error: null,
  }),
  useFollowTask: () => ({ mutate: followMutate, isPending: false }),
  useUnfollowTask: () => ({ mutate: unfollowMutate, isPending: false }),
}))

const taskId = 'c6ae2920-f763-4d9c-bf68-2200be37e3cf'
const raw = JSON.stringify({
  v: 1,
  blocks: [
    {
      type: 'actions',
      resolve: 'each',
      buttons: [
        {
          id: `follow-task:${taskId}`,
          text: '关注',
          style: 'default',
          action: 'url',
          url: `https://meet.example.test/tasks?task=${taskId}`,
        },
      ],
    },
  ],
})

describe('RichCardMessage task follow action', () => {
  beforeEach(() => {
    state.isFollowing = false
    followMutate.mockClear()
    unfollowMutate.mockClear()
  })

  it('follows an unfollowed task from the conversation card', () => {
    render(<RichCardMessage raw={raw} />)

    const button = screen.getByRole('button', { name: '关注' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(followMutate).toHaveBeenCalledWith(taskId)
  })

  it('shows 已关注 and toggles back to unfollow', () => {
    state.isFollowing = true
    render(<RichCardMessage raw={raw} />)

    const button = screen.getByRole('button', { name: '已关注' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button)
    expect(unfollowMutate).toHaveBeenCalledWith(taskId)
  })

  it('keeps the source conversation on a shared-card follow request', () => {
    const cid = '8d42ebf0-0059-47a7-89d0-1bb04d53768d'
    const sharedRaw = JSON.stringify({
      v: 1,
      blocks: [
        {
          type: 'actions',
          resolve: 'each',
          buttons: [
            {
              id: `follow-task:${taskId}:${cid}`,
              text: '关注',
              style: 'default',
              action: 'url',
              url: `https://meet.example.test/tasks?task=${taskId}&shared_via=${cid}`,
            },
          ],
        },
      ],
    })

    render(<RichCardMessage raw={sharedRaw} />)
    fireEvent.click(screen.getByRole('button', { name: '关注' }))

    expect(followMutate).toHaveBeenCalledWith({ taskId, sharedVia: cid })
  })
})
