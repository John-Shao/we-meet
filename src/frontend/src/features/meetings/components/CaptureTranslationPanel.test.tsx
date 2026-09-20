import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { RecordingController } from '../capture/controller'
import {
  payload,
  run,
  source,
  state as makeState,
  ticket,
} from '../capture/translation.testFixtures'
import type { CaptureTranslationPayload } from '../capture/translationProtocol'
import { CaptureTranslationPanel } from './CaptureTranslationPanel'
import type {
  CaptureTranslationSocket,
  TranslationSocketState,
} from '../capture/translationSocket'

type MockClient = {
  options: ConstructorParameters<typeof CaptureTranslationSocket>[0]
  abort: ReturnType<typeof vi.fn>
  begin: ReturnType<typeof vi.fn>
  endTurn: ReturnType<typeof vi.fn>
  update: (phase: TranslationSocketState['phase']) => void
}
type MockOutput = { mute: ReturnType<typeof vi.fn> }
const mocks = vi.hoisted(() => ({
  clients: [] as MockClient[],
  outputs: [] as MockOutput[],
}))
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { language: string }) =>
      values ? `${key}:${values.language}` : key,
  }),
}))
vi.mock('@/primitives', () => ({
  SearchBox: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (value: string) => void
    placeholder: string
  }) => (
    <input
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../capture/translationSocket', () => ({
  CaptureTranslationSocket: class {
    state: TranslationSocketState = { phase: 'connecting', finals: [] }
    constructor(
      public options: ConstructorParameters<typeof CaptureTranslationSocket>[0]
    ) {
      mocks.clients.push(this)
    }
    connect = vi.fn(() => this.update('ready'))
    abort = vi.fn(() => this.update('incomplete'))
    finish = vi.fn(() => this.update('stopped'))
    begin = vi.fn((direction: 'forward' | 'reverse') =>
      this.update('speaking', direction)
    )
    endTurn = vi.fn(() => this.update('awaiting'))
    update(
      phase: TranslationSocketState['phase'],
      direction?: 'forward' | 'reverse'
    ) {
      this.state = { ...this.state, phase }
      this.options.changed({ ...this.state, direction })
    }
  },
}))
vi.mock('../capture/translationPlayback', () => ({
  TranslationPlayback: class {
    constructor() {
      mocks.outputs.push(this)
    }
    unlock = vi.fn(async () => undefined)
    close = vi.fn()
    mute = vi.fn()
    play = vi.fn()
  },
}))
let controller: RecordingController
let remote = makeState(null)
let failure: unknown
let malformed = false
const key = `meeting-summary-intent:v1:${JSON.stringify(['capture-translation', source.viewerId, source.captureId])}`
const commands = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(
      ([path, options]) =>
        path.endsWith('/translation/') && options?.method === 'POST'
    )
const show = () =>
  render(
    <CaptureTranslationPanel
      source={source}
      revision={2}
      controller={controller}
    />
  )
const start = async () => {
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'translation.start' })
    ).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'translation.start' }))
}
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  mocks.clients.length = 0
  mocks.outputs.length = 0
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  controller = {
    state: {
      busy: false,
      mode: 'recording',
      local: {
        create: {
          device_id: source.deviceId,
          lease_key: source.leaseKey,
          retention_mode: 'media',
        },
        remote: { id: source.captureId, revision: 2, status: 'recording' },
      },
    },
    observePcm: vi.fn(),
  } as unknown as RecordingController
  remote = makeState(null)
  failure = undefined
  malformed = false
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (path.endsWith('/ticket/')) return ticket(remote.current!)
    if (options?.method !== 'POST') return structuredClone(remote)
    if (failure) throw failure
    const body = JSON.parse(options.body as string)
    const { key: commandKey, ...sent } = body
    const current = run()
    if (sent.operation === 'start')
      current.configuration = {
        ...current.configuration,
        ...sent.configuration,
      }
    else {
      current.status = 'stopped'
      current.ended_at = new Date().toISOString()
    }
    remote = makeState(current)
    return malformed
      ? {}
      : {
          command: {
            key: commandKey,
            capture_id: source.captureId,
            payload: sent,
            result: current,
          },
          current: remote,
          replayed: false,
        }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('starts from explicit choices, validates receipts and stores no credentials', async () => {
  show()
  expect(
    screen.getByRole('checkbox', { name: 'translation.audio' })
  ).not.toBeChecked()
  expect(
    screen.getByRole('checkbox', { name: 'translation.save' })
  ).not.toBeChecked()
  await start()
  await waitFor(() => expect(mocks.clients).toHaveLength(1))
  const body = JSON.parse(commands()[0][1]!.body as string)
  expect(body.configuration).toMatchObject({
    audio: false,
    save_translations: false,
  })
  expect(commands()[0][1]!.headers).toEqual({
    'X-Capture-Lease': source.leaseKey,
  })
  expect(sessionStorage.getItem(key)).toBeNull()
  expect(mocks.outputs).toHaveLength(0)
  expect(mocks.clients[0].options.authorized()).toBe(true)
})
it('retains an uncertain exact intent across remount and recovery never opens a socket', async () => {
  failure = new ApiError(408, {})
  const view = show()
  await start()
  await screen.findByText('translation.pending')
  const stored = sessionStorage.getItem(key)!
  expect(stored).not.toContain(source.leaseKey)
  expect(stored).not.toContain('ticket')
  const original = JSON.parse(commands()[0][1]!.body as string)
  view.unmount()
  failure = undefined
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'translation.recover' })
  )
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull())
  expect(JSON.parse(commands()[1][1]!.body as string)).toEqual(original)
  expect(mocks.clients).toHaveLength(0)
  expect(
    vi.mocked(fetchApi).mock.calls.some(([path]) => path.endsWith('/ticket/'))
  ).toBe(false)
})
it('does not clear a command from a malformed 2xx receipt', async () => {
  malformed = true
  show()
  await start()
  await screen.findByText('translation.actionFailed')
  expect(sessionStorage.getItem(key)).not.toBeNull()
  expect(mocks.clients).toHaveLength(0)
})
it('ignores late control responses across a visibility change', async () => {
  let resolve: (value: unknown) => void = () => undefined
  const original = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation((path, options) =>
    options?.method === 'POST'
      ? new Promise((r) => {
          resolve = r
        })
      : original(path, options)
  )
  show()
  await start()
  await waitFor(() => expect(commands()).toHaveLength(1))
  const stored = JSON.parse(sessionStorage.getItem(key)!)
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await act(async () =>
    resolve({
      command: {
        key: stored.key,
        capture_id: source.captureId,
        payload: stored.payload,
        result: run(),
      },
      current: makeState(),
      replayed: false,
    })
  )
  expect(sessionStorage.getItem(key)).not.toBeNull()
  expect(mocks.clients).toHaveLength(0)
})
it('uses frozen current run identity when stopping a disconnected translation', async () => {
  remote = makeState()
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'translation.stop' })
  )
  await waitFor(() => expect(commands()).toHaveLength(1))
  expect(JSON.parse(commands()[0][1]!.body as string)).toMatchObject({
    operation: 'stop',
    expected_revision: 2,
    expected_run_id: run().id,
    configuration: null,
  })
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull())
})
it('supports accessible start/finish speech controls and isolates output mute', async () => {
  show()
  fireEvent.change(screen.getByLabelText('translation.mode'), {
    target: { value: 'push_to_talk' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: 'translation.audio' }))
  await start()
  const forward = await screen.findByRole('button', {
    name: 'translation.speak:translation.zh',
  })
  fireEvent.click(forward)
  expect(mocks.clients[0].begin).toHaveBeenCalledWith('forward')
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'translation.endTurn:translation.zh',
    })
  )
  expect(mocks.clients[0].endTurn).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'translation.mute' }))
  expect(mocks.outputs[0].mute).toHaveBeenCalledWith(true)
  act(() => mocks.clients[0].update('ready'))
  fireEvent.click(
    screen.getByRole('button', { name: 'translation.speak:translation.en' })
  )
  expect(mocks.clients[0].begin).toHaveBeenLastCalledWith('reverse')
})
it('source pause and unmount revoke the consumer without invoking recording controls', async () => {
  const view = show()
  await start()
  await waitFor(() => expect(mocks.clients).toHaveLength(1))
  controller.state.mode = 'paused'
  expect(mocks.clients[0].options.authorized()).toBe(false)
  view.unmount()
  expect(mocks.clients[0].abort).toHaveBeenCalledTimes(1)
})
it('only explicit terminal rejections clear the pending operation', async () => {
  const pending: { key: string; payload: CaptureTranslationPayload } = {
    key: crypto.randomUUID(),
    payload: payload(),
  }
  sessionStorage.setItem(key, JSON.stringify(pending))
  failure = new ApiError(409, {})
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'translation.recover' })
  )
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull())
})
