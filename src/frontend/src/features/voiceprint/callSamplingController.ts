import { ApiError } from '@/api/ApiError'
import { sameAuthSession } from '@/features/auth/utils/tokenStorage'
import {
  CallSamplingClient,
  type SamplingConnection,
  type SamplingControl,
} from './callSamplingApi'

export type CallSamplingState = {
  snapshot?: SamplingConnection
  requestedAt: number
  loading: boolean
  busy: boolean
  deviceChanged: boolean
  error?:
    | 'unavailable'
    | 'conflict'
    | 'authentication_changed'
    | 'connection_pending'
}

/** A lifetime is one login AND one exact RTC connection, with no shared cache. */
export class CallSamplingController {
  private state: CallSamplingState = {
    requestedAt: 0,
    loading: false,
    busy: false,
    deviceChanged: false,
  }
  private observers = new Set<() => void>()
  private lifetime?: AbortController
  private reading?: AbortController
  private revision = 0
  private resettingDevice = false
  constructor(readonly client: CallSamplingClient) {}
  snapshot = () => this.state
  subscribe = (observer: () => void) => {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }
  private set(value: Partial<CallSamplingState>) {
    this.state = { ...this.state, ...value }
    this.observers.forEach((observer) => observer())
  }
  start() {
    this.lifetime = new AbortController()
    void this.refresh()
  }
  close() {
    this.lifetime?.abort()
    this.reading?.abort()
    this.reading = undefined
    this.revision++
    this.set({ snapshot: undefined, loading: false, busy: false })
  }
  private current(revision: number) {
    return (
      this.lifetime &&
      !this.lifetime.signal.aborted &&
      this.revision === revision &&
      sameAuthSession(this.client.auth)
    )
  }
  private failure(error: unknown, revision: number) {
    if (this.lifetime?.signal.aborted || revision !== this.revision) return
    this.set({
      snapshot: undefined,
      busy: false,
      loading: false,
      error: !sameAuthSession(this.client.auth)
        ? 'authentication_changed'
        : error instanceof ApiError && error.statusCode === 409
          ? 'conflict'
          : error instanceof ApiError && error.statusCode === 404
            ? 'connection_pending'
            : 'unavailable',
    })
  }
  async refresh() {
    if (
      !this.lifetime ||
      this.lifetime.signal.aborted ||
      this.reading ||
      this.state.busy
    )
      return
    const revision = ++this.revision
    const controller = new AbortController()
    this.reading = controller
    this.set({ loading: true })
    const requestedAt = Date.now()
    try {
      const snapshot = await this.client.read(controller.signal)
      if (this.current(revision))
        this.set({ snapshot, requestedAt, error: undefined })
      else this.failure(undefined, revision)
    } catch (error) {
      this.failure(error, revision)
    } finally {
      if (this.reading === controller) this.reading = undefined
      if (this.current(revision)) this.set({ loading: false })
      if (this.current(revision) && this.state.deviceChanged)
        void this.resetDevice()
    }
  }
  private async mutate(
    action: (
      snapshot: SamplingConnection,
      signal: AbortSignal
    ) => Promise<unknown>
  ) {
    const snapshot = this.state.snapshot
    if (
      !snapshot ||
      !this.lifetime ||
      this.lifetime.signal.aborted ||
      this.state.busy
    )
      return
    this.reading?.abort()
    const revision = ++this.revision
    this.set({ busy: true, error: undefined })
    try {
      await action(snapshot, this.lifetime.signal)
      if (!this.current(revision)) {
        this.failure(undefined, revision)
        return
      }
      const requestedAt = Date.now()
      const current = await this.client.read(this.lifetime.signal)
      if (this.current(revision))
        this.set({ snapshot: current, requestedAt, error: undefined })
      else this.failure(undefined, revision)
    } catch (error) {
      this.failure(error, revision)
    } finally {
      if (this.current(revision)) this.set({ busy: false, loading: false })
      if (this.current(revision) && this.state.deviceChanged)
        void this.resetDevice()
    }
  }
  declare(
    changes: Pick<
      SamplingControl,
      'paused' | 'shared_microphone' | 'device_group'
    >
  ) {
    if (this.state.deviceChanged) return Promise.resolve()
    return this.mutate((snapshot, signal) =>
      this.client.declare(snapshot, changes, signal)
    )
  }
  disableAccumulation() {
    return this.mutate((snapshot, signal) =>
      this.client.disableAccumulation(snapshot, signal)
    )
  }
  invalidateDevice() {
    if (!sameAuthSession(this.client.auth)) return
    this.set({ deviceChanged: true })
    void this.resetDevice()
  }
  private async resetDevice() {
    if (
      this.resettingDevice ||
      this.state.busy ||
      !this.state.snapshot ||
      !this.lifetime ||
      this.lifetime.signal.aborted
    )
      return
    const control = this.state.snapshot.control
    if (
      control.paused &&
      control.shared_microphone &&
      control.device_group === ''
    ) {
      this.set({ deviceChanged: false })
      return
    }
    this.resettingDevice = true
    try {
      await this.mutate((snapshot, signal) =>
        this.client.declare(
          snapshot,
          { paused: true, shared_microphone: true, device_group: '' },
          signal
        )
      )
      const current = this.state.snapshot?.control
      if (
        current?.paused &&
        current.shared_microphone &&
        current.device_group === ''
      )
        this.set({ deviceChanged: false })
    } finally {
      this.resettingDevice = false
    }
  }
  runtime(now: number) {
    if (!sameAuthSession(this.client.auth)) return 'unavailable'
    if (this.state.deviceChanged) return 'device_changed'
    if (this.state.busy) return 'changing'
    const snapshot = this.state.snapshot
    if (!snapshot || now - this.state.requestedAt >= 15000) return 'unavailable'
    const phase = snapshot.control.runtime.state
    if (
      (phase === 'sampling' || phase === 'uploading') &&
      snapshot.control.runtime.updated_at
    ) {
      // Count the whole request duration conservatively; a delayed response
      // must never renew a heartbeat that already expired on the server.
      const age =
        Date.parse(snapshot.observed_at) -
        Date.parse(snapshot.control.runtime.updated_at) +
        now -
        this.state.requestedAt
      if (age >= 5000 || age < 0) return 'waiting'
    }
    return phase
  }
}
