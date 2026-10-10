import { Blob, File } from 'node:buffer'
import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import zh from '@/locales/zh/voiceprint.json'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { VoiceprintSettingsPanel } from './VoiceprintSettingsPanel'
import { pcmWav } from './recording'
import {
  ENROLLMENT,
  OWNER,
  PROFILE,
  enrollment,
  sample,
  settings,
} from './fixtures.test-utils'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  blob: vi.fn(),
  loggedIn: true,
  refetch: vi.fn(),
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({
    user: { id: OWNER },
    isLoggedIn: mocks.loggedIn,
    refetch: mocks.refetch,
  }),
}))
vi.mock('@/api/fetchApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
  fetchApiBlob: mocks.blob,
}))
const i18n = createInstance()
let current = settings()
let registration = enrollment()
let clips: ReturnType<typeof sample>[]

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('Blob', Blob)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
    () => undefined
  )
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
    () => undefined
  )
  mocks.loggedIn = true
  setTokens({ accessToken: 'fixture-user' })
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    fallbackLng: 'zh',
    resources: { zh: { voiceprint: zh } },
    react: { useSuspense: false },
  })
  current = settings()
  registration = enrollment()
  clips = []
  mocks.fetch.mockImplementation(
    async (path: string, options?: RequestInit) => {
      if (path.startsWith('voiceprint/scopes/'))
        return { results: [], next_offset: null }
      if (path.startsWith('voiceprint/deletions/'))
        return { results: [], next_offset: null }
      if (path.startsWith('voiceprint/settings/')) {
        if (options?.method === 'PATCH') {
          current = {
            ...current,
            ...JSON.parse(String(options.body)),
            version: current.version + 1,
          }
          delete (current as Partial<{ expected_version: number }>)
            .expected_version
        }
        return current
      }
      if (path === 'voiceprint/enrollments/') return registration
      if (path.includes('/clips/')) {
        clips = [sample()]
        registration.uploaded_slots = [0]
        return clips[0]
      }
      if (path === `voiceprint/enrollments/${ENROLLMENT}/`) return registration
      if (path.startsWith('voiceprint/samples/'))
        return { results: clips, next_offset: null }
      throw new Error(`Unexpected fixture route: ${path}`)
    }
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const show = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintSettingsPanel />
      </StrictMode>
    </I18nextProvider>
  )

it('loads in React StrictMode without initiating registration, recording or implicit permissions', async () => {
  current = settings({
    version: 0,
    generation: 0,
    profiles: [],
    allow_enrollment: false,
  })
  show()
  expect(await screen.findByText('此作用域尚未登记声纹。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '开始登记' })).toBeDisabled()
  expect(mocks.fetch.mock.calls.every(([, options]) => !options?.method)).toBe(
    true
  )
})

it('changes only the selected permission with the current version and displayed owner', async () => {
  show()
  const control = await screen.findByRole('switch', {
    name: '允许使用本人声纹提供身份建议',
  })
  fireEvent.click(control)
  await waitFor(() =>
    expect(
      mocks.fetch.mock.calls.some(([, options]) => options?.method === 'PATCH')
    ).toBe(true)
  )
  const call = mocks.fetch.mock.calls.find(
    ([, options]) => options?.method === 'PATCH'
  )!
  expect(JSON.parse(call[1].body)).toEqual({
    organization_id: null,
    expected_version: 1,
    allow_identification: true,
  })
  expect(call[1].headers['X-Voiceprint-Owner']).toBe(OWNER)
})

it('shows registration prompts, local preview and uploaded quality-pending status without a confirmation action', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: '开始登记' }))
  expect(await screen.findByText('Read prompt 1')).toBeInTheDocument()
  const wav = pcmWav(new Float32Array(24000 * 3))
  const file = new File(
    [new Uint8Array(await wav.arrayBuffer())],
    'my-voice.wav',
    {
      type: 'audio/wav',
    }
  )
  fireEvent.change(screen.getByLabelText('或选择本人录好的 WAV 片段'), {
    target: { files: [file] },
  })
  expect(await screen.findByLabelText('上传前试听')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '上传本人片段' }))
  expect(await screen.findByText('质量待审核')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: '确认本人片段' })
  ).not.toBeInTheDocument()
  expect(screen.getByText('Read prompt 2')).toBeInTheDocument()
  const upload = mocks.fetch.mock.calls.find(
    ([, options]) => options?.method === 'PUT'
  )!
  expect(upload[1].body.size).toBe(144044)
  expect(upload[1].headers['x-voiceprint-upload-token']).toHaveLength(43)
})

it('requires a scope-specific review before deleting a profile and blocks stale conflict writes', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: '删除声纹' }))
  expect(
    await screen.findByText(/删除“个人账号”中的本人声纹/)
  ).toBeInTheDocument()
  expect(
    mocks.fetch.mock.calls.some(([, options]) => options?.method === 'DELETE')
  ).toBe(false)
  mocks.fetch.mockImplementation(
    async (path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE')
        throw new ApiError(409, { code: 'voiceprint_settings_changed' })
      if (path.startsWith('voiceprint/settings/')) return current
      return { results: [], next_offset: null }
    }
  )
  fireEvent.click(screen.getByRole('button', { name: '删除此作用域的声纹' }))
  expect(
    await screen.findByText('设置已在其他地方变更，请重新加载后再修改。')
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: '删除此作用域的声纹' })
  ).toBeDisabled()
  const call = mocks.fetch.mock.calls.find(
    ([, options]) => options?.method === 'DELETE'
  )!
  expect(call[0]).toContain(PROFILE)
})

it('does not request private settings or scope metadata for a signed-out viewer', () => {
  mocks.loggedIn = false
  show()
  expect(screen.getByText('请登录后管理本人的声纹。')).toBeInTheDocument()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('shows server verified device groups and update reasons instead of raw active status', async () => {
  current = settings({ display_state: 'needs_update' })
  current.profiles[0] = {
    ...current.profiles[0],
    status: 'active',
    display_state: 'needs_update',
    update_reasons: ['expired'],
    effective_device_groups: [],
  }
  show()
  expect(await screen.findByText('当前状态：需要更新')).toBeInTheDocument()
  expect(
    screen.getByText('声纹已超过一年未更新，请重新登记新片段。')
  ).toBeInTheDocument()
  expect(screen.getByText('有效设备组：无')).toBeInTheDocument()
  expect(screen.queryByText('已建立')).not.toBeInTheDocument()
})

it('does not claim physical deletion from legacy revoked profile metadata', async () => {
  delete current.display_state
  current.profiles[0] = {
    ...current.profiles[0],
    status: 'deleted',
  }
  delete current.profiles[0].display_state
  delete current.profiles[0].update_reasons
  delete current.profiles[0].effective_device_groups
  show()
  expect(await screen.findByText('删除中')).toBeInTheDocument()
  expect(screen.queryByText('已删除')).not.toBeInTheDocument()
})
