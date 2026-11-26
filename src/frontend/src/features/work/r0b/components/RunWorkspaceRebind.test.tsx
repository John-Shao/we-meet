import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunWorkspaceRebind } from './RunWorkspaceRebind'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../r0a/api/queries', () => ({
  useWorkBootstrap: () => ({ data: { phases: ['R0b'] } }),
}))

vi.mock('../../r0a/hooks/useReadOnlyViewport', () => ({
  useReadOnlyViewport: () => false,
}))

const grants = [
  {
    grantId: '11111111-1111-4111-8111-111111111111',
    rootIdentityHash: `sha256:${'a'.repeat(64)}`,
    artifactDir: ['WeMeet成果'],
  },
  {
    grantId: '22222222-2222-4222-8222-222222222222',
    rootIdentityHash: `sha256:${'a'.repeat(64)}`,
    artifactDir: ['WeMeet成果'],
  },
  {
    grantId: '33333333-3333-4333-8333-333333333333',
    rootIdentityHash: `sha256:${'b'.repeat(64)}`,
    artifactDir: ['other'],
  },
]

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RunWorkspaceRebind runId="run-1" runState="waiting" waitReason="input" />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  const rebindRunWorkspace = vi.fn().mockResolvedValue({
    status: 'accepted',
    rebound: {
      runId: 'run-1',
      oldGrantId: grants[0].grantId,
      newGrantId: grants[1].grantId,
      bindingRevision: 2,
      state: 'active',
      invalidatedReadonlyGrants: 0,
      replayed: false,
    },
  })
  Object.defineProperty(window, 'weMeetDesktop', {
    configurable: true,
    value: {
      work: {
        listWorkspaceGrants: vi.fn().mockResolvedValue(grants),
        grantWorkspace: vi.fn().mockResolvedValue(null),
        rebindRunWorkspace,
        onWorkspaceRebound: () => () => {},
      },
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'weMeetDesktop')
  vi.restoreAllMocks()
})

describe('RunWorkspaceRebind', () => {
  it('offers only same-root successors and submits the selected pair', async () => {
    renderPage()
    const current = await screen.findByLabelText('task.workspaceRebindCurrent')
    const next = (await screen.findByLabelText(
      'task.workspaceRebindNew'
    )) as HTMLSelectElement
    expect(current).toHaveValue(grants[0].grantId)
    expect(next).toHaveValue(grants[1].grantId)
    expect(Array.from(next.options).map((option) => option.value)).toEqual([
      grants[1].grantId,
    ])

    fireEvent.click(
      screen.getByRole('button', { name: 'task.workspaceRebindSubmit' })
    )
    await waitFor(() =>
      expect(
        window.weMeetDesktop?.work?.rebindRunWorkspace
      ).toHaveBeenCalledWith('run-1', grants[0].grantId, grants[1].grantId)
    )
    expect(
      await screen.findByText('task.workspaceRebindSuccess')
    ).toBeInTheDocument()
  })

  it('adds a grant through the native flow and selects it as the successor', async () => {
    const grantWorkspace = vi.fn().mockResolvedValue(grants[1])
    Object.defineProperty(window, 'weMeetDesktop', {
      configurable: true,
      value: {
        work: {
          listWorkspaceGrants: vi.fn().mockResolvedValue(grants),
          grantWorkspace,
          rebindRunWorkspace: vi.fn(),
          onWorkspaceRebound: () => () => {},
        },
      },
    })
    renderPage()
    await screen.findByLabelText('task.workspaceRebindCurrent')
    fireEvent.click(
      screen.getByRole('button', { name: 'task.workspaceGrantAdd' })
    )
    await waitFor(() =>
      expect(grantWorkspace).toHaveBeenCalledWith(['WeMeet成果'])
    )
    expect(
      await screen.findByText('task.workspaceGrantAdded')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('task.workspaceRebindNew')).toHaveValue(
      grants[1].grantId
    )
  })

  it('does not expose rebind outside waiting(input)', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <RunWorkspaceRebind runId="run-1" runState="active" waitReason={null} />
      </QueryClientProvider>
    )
    expect(screen.queryByText('task.workspaceRebind')).toBeNull()
  })
})
