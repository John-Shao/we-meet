// Map frontend language codes to backend language codes

export type BackendLanguage = 'zh-cn' | 'en-us' | 'fr-fr' | 'nl-nl' | 'de-de'
export type FrontendLanguage = 'zh' | 'en' | 'fr' | 'nl' | 'de'

const frontendToBackendMap: Record<FrontendLanguage, BackendLanguage> = {
  zh: 'zh-cn',
  en: 'en-us',
  fr: 'fr-fr',
  nl: 'nl-nl',
  de: 'de-de',
}

export const convertToBackendLanguage = (
  frontendLang: string = 'zh'
): BackendLanguage => {
  return frontendToBackendMap[frontendLang as FrontendLanguage]
}
