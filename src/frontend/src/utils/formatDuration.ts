import humanizeDuration from 'humanize-duration'

/** Translate i18next/BCP 47 locales to humanize-duration's locale names. */
export const formatDuration = (
  milliseconds: number,
  language: string | undefined,
  options: Omit<humanizeDuration.Options, 'language' | 'fallbacks'> = {}
) => {
  const locale = (language || 'zh').replace(/_/g, '-').toLowerCase()
  const baseLanguage = locale.split('-')[0]
  const durationLanguage =
    baseLanguage === 'zh'
      ? /-(hant|tw|hk|mo)(-|$)/.test(locale)
        ? 'zh_TW'
        : 'zh_CN'
      : locale.replace(/-/g, '_')

  return humanizeDuration(milliseconds, {
    ...options,
    language: durationLanguage,
    fallbacks: [baseLanguage, 'zh_CN'],
  })
}
