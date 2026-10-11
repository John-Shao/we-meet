import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import zh from '@/locales/zh/voiceprint.json'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { VoiceprintClient } from './api'
import { ORG, OWNER } from './fixtures.test-utils'
import { parseOperations } from './operations'
import { operationFixture } from './operations.test-utils'
import { VoiceprintOperationsPanel } from './VoiceprintOperationsPanel'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/api/fetchApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
}))
const i18n = createInstance()
beforeEach(async () => {
  vi.clearAllMocks()
  setTokens({ accessToken: 'synthetic-admin-session' })
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { voiceprint: zh } },
    interpolation: { escapeValue: false },
  })
})

const show = (client: VoiceprintClient) =>
  render(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintOperationsPanel client={client} />
      </StrictMode>
    </I18nextProvider>
  )
const load = () =>
  fireEvent.click(screen.getByRole('button', { name: '查看／刷新运行状态' }))

it('requests only the selected organization with the pinned owner and no cache', async () => {
  mocks.fetch.mockResolvedValue(operationFixture())
  const result = await new VoiceprintClient(ORG, OWNER).operations()
  expect(result.queues.encoding.pending).toBe(3)
  expect(result.queues.encoding.p95).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledWith(
    `voiceprint/organizations/${ORG}/operations/`,
    expect.objectContaining({
      cache: 'no-store',
      headers: expect.objectContaining({ 'X-Voiceprint-Owner': OWNER }),
      signal: expect.any(AbortSignal),
    })
  )
})

it('rejects personal scope and unsafe counters or durations, drops unrelated fields', async () => {
  await expect(new VoiceprintClient(null, OWNER).operations()).rejects.toThrow()
  expect(mocks.fetch).not.toHaveBeenCalled()
  const value = { ...operationFixture(), privateNames: ['not-for-retention'] }
  expect(JSON.stringify(parseOperations(value))).not.toContain(
    'not-for-retention'
  )
  for (const duration of [-1, NaN, Infinity, '12']) {
    const bad = operationFixture()
    bad.queues.encoding.oldest_pending_seconds = duration as number
    expect(() => parseOperations(bad)).toThrow('voiceprint_response_invalid')
  }
  const fractional = operationFixture()
  fractional.profiles.paused = 1.5
  expect(() => parseOperations(fractional)).toThrow()
})

it('shows aggregates with missing P95 rather than a fictitious zero', async () => {
  mocks.fetch.mockResolvedValue(operationFixture())
  show(new VoiceprintClient(ORG, OWNER))
  expect(mocks.fetch).not.toHaveBeenCalled()
  load()
  await screen.findByText(
    '贡献清理积压 5；暂停档案 6；近 24 小时人工拒绝建议 7'
  )
  expect(
    screen.getAllByText('最早积压时长 12 秒；请求至完成 P95 暂无数据')
  ).toHaveLength(4)
  expect(
    screen.getByText('近 24 小时质量元数据中的有效语音：30 秒')
  ).toBeTruthy()
})

it('clears old statistics before a failed refresh', async () => {
  mocks.fetch
    .mockResolvedValueOnce(operationFixture())
    .mockRejectedValueOnce(new Error('private-server-detail'))
  show(new VoiceprintClient(ORG, OWNER))
  load()
  await screen.findByText(
    '贡献清理积压 5；暂停档案 6；近 24 小时人工拒绝建议 7'
  )
  load()
  await screen.findByRole('alert')
  expect(screen.queryByText(/贡献清理积压 5/)).toBeNull()
  expect(screen.queryByText('private-server-detail')).toBeNull()
})

it('cancels an unmounted request and ignores its late response', async () => {
  let release: (value: unknown) => void = () => undefined
  mocks.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const view = show(new VoiceprintClient(ORG, OWNER))
  load()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
  const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
  release(operationFixture())
  show(new VoiceprintClient(ORG, OWNER))
  expect(screen.queryByText(/贡献清理积压 5/)).toBeNull()
})

it('rejects an operations response after a login switch', async () => {
  let release: (value: unknown) => void = () => undefined
  mocks.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = new VoiceprintClient(ORG, OWNER).operations()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
  setTokens({ accessToken: 'another-admin-session' })
  release(operationFixture())
  await expect(pending).rejects.toThrow()
})
