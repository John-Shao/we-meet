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

beforeEach(() => {
  mocks.profile.mockReturnValue({
    data: profile,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  })
  mocks.probe.mockReturnValue({ data: undefined })
  mocks.getCurrentSessionId.mockResolvedValue('session-1')
  mocks.createDeviceModelBinding.mockResolvedValue({
    bindingId: 'binding-1',
    status: 'awaiting_probe',
    probePreview: { probeId: 'probe-1' },
  })
  mocks.submitConfigurationProbe.mockResolvedValue({
    taskId: 'probe-task-1',
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
      expect(mocks.submitConfigurationProbe).toHaveBeenCalledWith('binding-1')
    )
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
