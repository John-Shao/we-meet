import { useEffect, useState } from 'react'

/** Desktop-only service and login feedback; web retains its existing layout. */
export function DesktopStatusBar() {
  const bridge = window.weMeetDesktop
  const [status, setStatus] = useState<DesktopStatus>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!bridge) return
    let active = true
    const update = (value: DesktopStatus) => {
      if (active) setStatus(value)
    }
    const unsubscribe = bridge.onStatus(update)
    void bridge
      .getStatus()
      .then(update)
      .catch(() => setError('桌面服务连接失败，请重启客户端。'))
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])
  if (!bridge) return null
  const offline = status?.connection === 'offline'
  const message =
    error || (offline ? '无法连接服务，请检查网络后重试。' : status?.message)
  if (!message) return null
  const run = (action: () => Promise<void>) => {
    setError('')
    void action().catch(() => setError('操作未完成，请重试。'))
  }
  return (
    <aside
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        padding: '12px 16px',
        maxWidth: '90vw',
        borderRadius: 8,
        background: '#fff8e5',
        color: '#3b321d',
        boxShadow: '0 2px 12px #0002',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
      }}
    >
      <span>{message}</span>
      {status?.auth === 'signing-in' ? (
        <button onClick={() => run(bridge.logout)}>取消登录</button>
      ) : offline ? (
        <button onClick={() => run(bridge.retry)}>重新连接</button>
      ) : (
        <button onClick={() => run(bridge.login)}>重新登录</button>
      )}
    </aside>
  )
}
