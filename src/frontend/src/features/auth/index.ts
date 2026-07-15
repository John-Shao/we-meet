export { useUser } from './api/useUser'
export { useSyncUserPreferencesWithBackend } from './api/useSyncUserPreferencesWithBackend'
export { authUrl } from './utils/authUrl'
export { UserAware } from './components/UserAware'
// QrLoginPanel（扫码登录 UI + 轮询态机）暂留待复用：后续把扫码接入 Keycloak
// 认证流做二维码 SSO 时，这套逻辑搬进 KC theme。手机号 OTP 的自绘组件
// （PhoneLoginPanel/PhoneLoginDialog）已移除——web 手机号登录由 KC phone-authenticator 取代。
export { QrLoginPanel } from './components/QrLoginPanel'
