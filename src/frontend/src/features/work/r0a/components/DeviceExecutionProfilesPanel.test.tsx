import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DeviceExecutionProfilesPanel } from './DeviceExecutionProfilesPanel'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  probe: vi.fn(),
  getCurrentSessionId: vi.fn(),
  createDeviceModelBinding: vi.fn(),
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
    status: 'awaiting_probe',
    probePreview: { probeId: 'probe-1' },
  })
  Object.defineProperty(window, 'weMeetDesktop', {
    configurable: true,
    value: {
      work: {
        getCurrentSessionId: mocks.getCurrentSessionId,
        createDeviceModelBinding: mocks.createDeviceModelBinding,
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
    render(<DeviceExecutionProfilesPanel profileId="profile-1" />)
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
  })

  it('shows a retryable profile load failure', () => {
    mocks.profile.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    })
    render(<DeviceExecutionProfilesPanel profileId="profile-1" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'deviceExecution.loadFailed'
    )
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument()
  })

  it('reports binding failure without claiming a probe succeeded', async () => {
    mocks.createDeviceModelBinding.mockRejectedValue(new Error('refused'))
    render(<DeviceExecutionProfilesPanel profileId="profile-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'deviceExecution.configure' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'deviceExecution.failed'
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
