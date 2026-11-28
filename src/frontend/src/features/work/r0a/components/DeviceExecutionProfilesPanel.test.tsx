import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { DeviceExecutionProfilesPanel } from './DeviceExecutionProfilesPanel'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  probe: vi.fn(),
  getCurrentSessionId: vi.fn(),
  createDeviceModelBinding: vi.fn(),
  submitConfigurationProbe: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}))
vi.mock('../api/queries', () => ({
  useActiveExecutionProfile: mocks.profile,
  useModelProbe: mocks.probe,
}))
vi.mock('../../r0b/api/queries', () => ({
  useWorkPendingLocalApprovals: () => ({ data: [] }),
}))

const profile = {
  profileId: 'profile-1',
  revision: 2,
  model: 'fixture-model',
  allowedPorts: [11434],
}

const ids = {
  binding: '11111111-1111-4111-8111-111111111111',
  probe: '22222222-2222-4222-8222-222222222222',
  task: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
}
const storageKey = 'we-meet:work:configuration-probe:profile-1'

beforeEach(() => {
  window.localStorage.clear()
  mocks.profile.mockReturnValue({
    data: profile,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  })
  mocks.probe.mockReturnValue({ data: undefined })
  mocks.getCurrentSessionId.mockResolvedValue('session-1')
  mocks.createDeviceModelBinding.mockResolvedValue({
    bindingId: ids.binding,
    status: 'awaiting_probe',
    probePreview: { probeId: ids.probe },
  })
  mocks.submitConfigurationProbe.mockResolvedValue({
    taskId: ids.task,
    runId: ids.run,
    probeId: ids.probe,
    bindingId: ids.binding,
    state: 'running',
  })
  Object.defineProperty(window, 'weMeetDesktop', {
    configurable: true,
    value: {
      work: {
        getCurrentSessionId: mocks.getCurrentSessionId,
        createDeviceModelBinding: mocks.createDeviceModelBinding,
        submitConfigurationProbe: mocks.submitConfigurationProbe,
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'weMeetDesktop')
})

describe('DeviceExecutionProfilesPanel', () => {
  it('creates a binding for the active profile and current Broker session', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    expect(screen.getByText('deviceExecution.title')).toBeInTheDocument()
    expect(screen.getByText(/deviceExecution\.profile:/)).toHaveTextContent(
      'fixture-model'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'deviceExecution.configure' })
    )
    await waitFor(() =>
      expect(mocks.createDeviceModelBinding).toHaveBeenCalledWith(
        'profile-1',
        11434,
        'session-1'
      )
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'deviceExecution.binding'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'deviceExecution.runProbe' })
    )
    await waitFor(() =>
      expect(mocks.submitConfigurationProbe).toHaveBeenCalledWith(ids.binding)
    )
    expect(window.localStorage.getItem(storageKey)).toBe(ids.probe)
    expect(
      await screen.findByText('deviceExecution.probeApprovalHint')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'deviceExecution.runProbe' })
    ).not.toBeInTheDocument()
  })

  it('shows a verified binding after the probe verifies', async () => {
    mocks.probe.mockReturnValue({ data: { state: 'verified' } })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'deviceExecution.configure' })
    )
    expect(await screen.findByRole('status')).toHaveTextContent('verified')
  })

  it('restores a submitted probe and its approval entry after remount', async () => {
    window.localStorage.setItem(storageKey, ids.probe)
    mocks.probe.mockImplementation((probeId: string | undefined) => ({
      data:
        probeId === ids.probe
          ? {
              probeId: ids.probe,
              bindingId: ids.binding,
              profileId: profile.profileId,
              state: 'running',
              taskId: ids.task,
              runId: ids.run,
            }
          : undefined,
    }))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    expect(await screen.findByRole('status')).toHaveTextContent('running')
    expect(
      await screen.findByText('deviceExecution.probeApprovalHint')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'deviceExecution.runProbe' })
    ).not.toBeInTheDocument()
    expect(mocks.submitConfigurationProbe).not.toHaveBeenCalled()
  })

  it('drops a stored probe that belongs to another profile', async () => {
    window.localStorage.setItem(storageKey, ids.probe)
    mocks.probe.mockReturnValue({
      data: {
        probeId: ids.probe,
        bindingId: ids.binding,
        profileId: 'another-profile',
        state: 'running',
        taskId: ids.task,
        runId: ids.run,
      },
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    await waitFor(() =>
      expect(window.localStorage.getItem(storageKey)).toBeNull()
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a retryable profile load failure', () => {
    mocks.profile.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'deviceExecution.loadFailed'
    )
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument()
  })

  it('reports binding failure without claiming a probe succeeded', async () => {
    mocks.createDeviceModelBinding.mockRejectedValue(new Error('refused'))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceExecutionProfilesPanel profileId="profile-1" />
      </QueryClientProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'deviceExecution.configure' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'deviceExecution.failed'
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
