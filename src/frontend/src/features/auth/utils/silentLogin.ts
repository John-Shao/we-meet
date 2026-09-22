import { authUrl } from '@/features/auth'

const SILENT_LOGIN_RETRY_KEY = 'silent-login-retry'

const isRetryAllowed = () => {
  // Native credentials are restored by the main process. Never automatically
  // open the system browser because a background /users/me request returned 401.
  if (window.weMeetDesktop?.isDesktop) return false
  const lastRetryDate = localStorage.getItem(SILENT_LOGIN_RETRY_KEY)
  if (!lastRetryDate) {
    return true
  }
  const now = new Date()
  return now.getTime() > Number(lastRetryDate)
}

const setNextRetryTime = (retryIntervalInSeconds: number) => {
  const now = new Date()
  const nextRetryTime = now.getTime() + retryIntervalInSeconds * 1000
  localStorage.setItem(SILENT_LOGIN_RETRY_KEY, String(nextRetryTime))
}

const initiateSilentLogin = () => {
  window.location.href = authUrl({ silent: true })
}

export const canAttemptSilentLogin = () => {
  return isRetryAllowed()
}

export const attemptSilentLogin = (retryIntervalInSeconds: number) => {
  if (!isRetryAllowed()) {
    return
  }
  setNextRetryTime(retryIntervalInSeconds)
  initiateSilentLogin()
}
