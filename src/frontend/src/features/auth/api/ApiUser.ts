import { BackendLanguage } from '@/utils/languages'

export type ApiUser = {
  id: string
  email: string
  full_name: string
  last_name: string
  language: BackendLanguage
  timezone: string
  /** Short-lived presigned GET URL for the avatar; '' when unset. */
  avatar_url?: string
}
