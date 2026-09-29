import { act, renderHook } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useHumanizeRecordingMaxDuration } from './useHumanizeRecordingMaxDuration'

const config = vi.hoisted(() => ({
  data: { recording: { max_duration: 7200000 } },
}))

vi.mock('@/api/useConfig', () => ({ useConfig: () => config }))

describe('useHumanizeRecordingMaxDuration', () => {
  it('renders Chinese recording limits and updates when only the language changes', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'zh',
      fallbackLng: 'zh',
      resources: { zh: { translation: {} }, en: { translation: {} } },
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    )

    const { result } = renderHook(() => useHumanizeRecordingMaxDuration(), {
      wrapper,
    })
    expect(result.current).toBe('2 小时')

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(result.current).toBe('2 hours')
  })
})
