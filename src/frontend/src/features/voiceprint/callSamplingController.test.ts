import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { CallSamplingClient } from './callSamplingApi'
import { CallSamplingController } from './callSamplingController'
import {
  connection,
  activeConnection,
  OWNER,
  ROOM,
  PARTICIPANT,
} from './callSampling.test-utils'

let controllers: CallSamplingController[]
beforeEach(() => {
  vi.restoreAllMocks()
  setTokens({ accessToken: 'synthetic-login' })
  controllers = []
})
afterEach(() => {
  controllers.forEach((c) => c.close())
  vi.useRealTimers()
})
async function setup(value = connection()) {
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  const read = vi
    .spyOn(client, 'read')
    .mockImplementation(async () => structuredClone(value))
  const declare = vi
    .spyOn(client, 'declare')
    .mockImplementation(async (_, changes) => {
      Object.assign(value.control, changes)
      value.control.revision++
      value.control.state = changes.paused ? 'paused' : 'ready'
      value.control.runtime = {
        state: changes.paused ? 'stopped' : 'waiting',
        reason: '',
        updated_at: null,
      }
      return structuredClone(value.control)
    })
  const disable = vi
    .spyOn(client, 'disableAccumulation')
    .mockResolvedValue(undefined as never)
  const controller = new CallSamplingController(client)
  controllers.push(controller)
  controller.start()
  await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false))
  return { client, controller, value, read, declare, disable }
}

it('reads without any implicit permission, declaration or capture', async () => {
  const { controller, declare, disable } = await setup()
  expect(controller.runtime(Date.now())).toBe('stopped')
  expect(declare).not.toHaveBeenCalled()
  expect(disable).not.toHaveBeenCalled()
})

it('expires positive activity after five seconds and the connection projection after fifteen', async () => {
  const { controller } = await setup(activeConnection())
  const requested = controller.snapshot().requestedAt
  expect(controller.runtime(requested)).toBe('sampling')
  expect(controller.runtime(requested + 5000)).toBe('waiting')
  expect(controller.runtime(requested + 15000)).toBe('unavailable')
})

it('counts response transit time toward the activity expiry', async () => {
  vi.useFakeTimers()
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  const value = activeConnection()
  let finish!: (result: typeof value) => void
  vi.spyOn(client, 'read').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const controller = new CallSamplingController(client)
  controllers.push(controller)
  controller.start()
  await vi.advanceTimersByTimeAsync(6000)
  finish(value)
  await Promise.resolve()
  expect(controller.runtime(Date.now())).toBe('waiting')
})

it('never retries a lost resume acknowledgement and clears uncertain state', async () => {
  const { controller, declare } = await setup()
  declare.mockRejectedValue(new Error('private server message'))
  await controller.declare({
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
  })
  expect(declare).toHaveBeenCalledOnce()
  expect(controller.snapshot().snapshot).toBeUndefined()
  expect(controller.snapshot().error).toBe('unavailable')
  expect(controller.runtime(Date.now())).toBe('unavailable')
  await controller.refresh()
  expect(declare).toHaveBeenCalledOnce()
})

it('shows conflict until the read restores current revision, without replaying the command', async () => {
  const { controller, declare, value } = await setup()
  declare.mockRejectedValue(new ApiError(409, {}))
  await controller.declare({
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
  })
  expect(controller.snapshot().error).toBe('conflict')
  value.control.revision = 9
  await controller.refresh()
  expect(controller.snapshot().snapshot?.control.revision).toBe(9)
  expect(declare).toHaveBeenCalledOnce()
})

it('discards a late read superseded by a pause command', async () => {
  const { controller, read, value } = await setup(activeConnection())
  const old = structuredClone(value)
  let finish!: (value: typeof old) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = controller.refresh()
  await controller.declare({
    paused: true,
    shared_microphone: false,
    device_group: 'headset',
  })
  finish(old)
  await pending
  expect(controller.snapshot().snapshot?.control.paused).toBe(true)
  expect(controller.runtime(Date.now())).toBe('stopped')
})

it('clears the connection at disposal and cannot accept a response into a restarted lifetime', async () => {
  const { controller, read } = await setup()
  let finish!: (value: ReturnType<typeof activeConnection>) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = controller.refresh()
  controller.close()
  expect(controller.snapshot().snapshot).toBeUndefined()
  controller.start()
  await vi.waitFor(() => expect(controller.snapshot().loading).toBe(false))
  finish(activeConnection())
  await pending
  expect(controller.runtime(Date.now())).toBe('stopped')
})

it('hides private state after the login changes while a command is pending', async () => {
  const { controller, declare } = await setup()
  let finish!: () => void
  declare.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(connection().control)
      })
  )
  const pending = controller.declare({
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
  })
  setTokens({ accessToken: 'other-login' })
  finish()
  await pending
  expect(controller.snapshot().error).toBe('authentication_changed')
  expect(controller.snapshot().snapshot).toBeUndefined()
  expect(controller.runtime(Date.now())).toBe('unavailable')
})

it('invalidates sampling immediately on device change, then pauses and clears the declaration', async () => {
  const { controller, declare } = await setup(activeConnection())
  controller.invalidateDevice()
  expect(controller.runtime(Date.now())).toBe('device_changed')
  await vi.waitFor(() =>
    expect(controller.snapshot().deviceChanged).toBe(false)
  )
  expect(declare).toHaveBeenCalledWith(
    expect.anything(),
    { paused: true, shared_microphone: true, device_group: '' },
    expect.any(AbortSignal)
  )
  expect(controller.runtime(Date.now())).toBe('stopped')
})

it('retries only a safe device reset after an uncertain acknowledgement and read', async () => {
  const { controller, declare } = await setup(activeConnection())
  declare.mockRejectedValueOnce(new Error('connection interrupted'))
  controller.invalidateDevice()
  await vi.waitFor(() =>
    expect(controller.snapshot().error).toBe('unavailable')
  )
  expect(controller.runtime(Date.now())).toBe('device_changed')
  await controller.declare({
    paused: false,
    shared_microphone: false,
    device_group: 'computer',
  })
  expect(declare).toHaveBeenCalledOnce()
  await controller.refresh()
  await vi.waitFor(() =>
    expect(controller.snapshot().deviceChanged).toBe(false)
  )
  expect(declare).toHaveBeenCalledTimes(2)
  expect(
    declare.mock.calls.every(
      ([, changes]) =>
        changes.paused &&
        changes.shared_microphone &&
        changes.device_group === ''
    )
  ).toBe(true)
})

it('queues a safe reset when the device changes during a command', async () => {
  const { controller, declare, value } = await setup(activeConnection())
  let finish!: () => void
  declare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(value.control)
      })
  )
  const pending = controller.declare({
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
  })
  controller.invalidateDevice()
  expect(controller.runtime(Date.now())).toBe('device_changed')
  finish()
  await pending
  await vi.waitFor(() =>
    expect(controller.snapshot().deviceChanged).toBe(false)
  )
  expect(declare).toHaveBeenCalledTimes(2)
  expect(declare.mock.calls[1][1]).toEqual({
    paused: true,
    shared_microphone: true,
    device_group: '',
  })
})

it('does not write a device reset when the server is already safely undeclared', async () => {
  const { controller, declare } = await setup()
  controller.invalidateDevice()
  expect(controller.snapshot().deviceChanged).toBe(false)
  expect(declare).not.toHaveBeenCalled()
})
