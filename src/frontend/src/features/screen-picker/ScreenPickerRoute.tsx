import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RiCheckLine,
  RiComputerLine,
  RiErrorWarningLine,
  RiRefreshLine,
  RiWindowLine,
} from '@remixicon/react'
import type {
  ScreenPickerData,
  ScreenPickerItem,
} from '../../../../desktop/src/screen-picker/bridge'
import './ScreenPicker.css'

const bridge = () => window.weMeetDesktop?.screenPicker

export default function ScreenPickerRoute() {
  const [data, setData] = useState<ScreenPickerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [starting, setStarting] = useState(false)
  const request = useRef(0)
  const readySent = useRef(false)

  const load = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setError('')
    setSelected('')
    try {
      const picker = bridge()
      if (!picker) throw new Error('unsupported')
      const next = await picker.get()
      if (sequence !== request.current) return
      setData(next)
    } catch {
      if (sequence !== request.current) return
      setData(null)
      setError('无法获取可共享的屏幕和窗口，请重试。')
    } finally {
      if (sequence === request.current) setLoading(false)
      if (sequence === request.current && !readySent.current) {
        readySent.current = true
        const picker = bridge()
        // Let React commit the first grid before main shows the window, so the
        // desktop thumbnail cannot contain the picker's own skeleton.
        if (picker) window.setTimeout(() => picker.ready(), 60)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      const picker = bridge()
      if (picker) picker.cancel()
      else window.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!starting) return
    const timer = window.setTimeout(() => {
      setStarting(false)
      setError('共享未能开始，请重新选择。')
      void load()
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [starting, load])

  const start = (token = selected) => {
    if (!token || starting) return
    const picker = bridge()
    if (!picker) {
      setError('当前环境不支持屏幕共享。')
      return
    }
    setError('')
    setStarting(true)
    try {
      picker.choose(token)
    } catch {
      setStarting(false)
      setError('共享未能开始，请重试。')
    }
  }

  const cancel = () => {
    const picker = bridge()
    if (picker) picker.cancel()
    else window.close()
  }

  const selectedItem = [
    ...(data?.screens ?? []),
    ...(data?.windows ?? []),
  ].find((item) => item.token === selected)
  const empty =
    !loading && !!data && !data.screens.length && !data.windows.length

  return (
    <div className="screen-picker" data-testid="screen-picker">
      <header className="screen-picker-titlebar">选择要共享的屏幕或窗口</header>
      <main className="screen-picker-body">
        <div className="screen-picker-heading">
          <div>
            <h1>桌面与窗口</h1>
            <p>选择要共享的屏幕或应用窗口，仅会共享你选中的内容。</p>
          </div>
          <button
            type="button"
            className="screen-picker-refresh"
            onClick={() => void load()}
            disabled={loading}
            data-testid="screen-picker-refresh"
          >
            <RiRefreshLine
              size={15}
              aria-hidden="true"
              className={loading ? 'is-spinning' : undefined}
            />
            刷新
          </button>
        </div>

        {error && (
          <div className="screen-picker-error" role="alert">
            <RiErrorWarningLine size={16} aria-hidden="true" />
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="screen-picker-loading" role="status">
            <span>正在获取可共享的屏幕和窗口…</span>
            <div className="screen-picker-grid" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="screen-picker-skeleton">
                  <span />
                  <i />
                </div>
              ))}
            </div>
          </div>
        ) : empty ? (
          <div className="screen-picker-empty" role="status">
            <RiWindowLine size={36} aria-hidden="true" />
            <strong>未检测到可共享的内容</strong>
            <span>请先打开需要共享的窗口，然后点击刷新。</span>
          </div>
        ) : (
          data && (
            <>
              <section
                className="screen-picker-section"
                aria-labelledby="screen-picker-screens"
              >
                <h2 id="screen-picker-screens">
                  桌面
                  <span>{data.screens.length}</span>
                </h2>
                {data.screens.length ? (
                  <div
                    className="screen-picker-grid"
                    role="group"
                    aria-labelledby="screen-picker-screens"
                  >
                    {data.screens.map((item) => (
                      <Card
                        key={item.token}
                        item={item}
                        kind="screen"
                        selected={selected === item.token}
                        disabled={loading || starting}
                        onSelect={setSelected}
                        onOpen={start}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="screen-picker-none">没有可共享的桌面。</p>
                )}
              </section>

              <section
                className="screen-picker-section"
                aria-labelledby="screen-picker-windows"
              >
                <h2 id="screen-picker-windows">
                  窗口
                  <span>{data.windows.length}</span>
                </h2>
                {data.windows.length ? (
                  <div
                    className="screen-picker-grid"
                    role="group"
                    aria-labelledby="screen-picker-windows"
                  >
                    {data.windows.map((item) => (
                      <Card
                        key={item.token}
                        item={item}
                        kind="window"
                        selected={selected === item.token}
                        disabled={loading || starting}
                        onSelect={setSelected}
                        onOpen={start}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="screen-picker-none">没有打开的窗口。</p>
                )}
              </section>
            </>
          )
        )}
      </main>

      <footer className="screen-picker-footer">
        <span className="screen-picker-hint" data-testid="screen-picker-hint">
          {selectedItem
            ? `已选择：${selectedItem.title}`
            : '停止共享请使用通话或会议中的按钮。'}
        </span>
        <div className="screen-picker-actions">
          <button
            type="button"
            className="screen-picker-button"
            onClick={cancel}
            disabled={starting}
            data-testid="screen-picker-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className="screen-picker-button screen-picker-button--primary"
            onClick={() => start()}
            disabled={!selected || starting || loading}
            data-testid="screen-picker-start"
          >
            {starting ? '正在共享…' : '开始共享'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function Card({
  item,
  kind,
  selected,
  disabled,
  onSelect,
  onOpen,
}: {
  item: ScreenPickerItem
  kind: 'screen' | 'window'
  selected: boolean
  disabled: boolean
  onSelect: (token: string) => void
  onOpen: (token: string) => void
}) {
  return (
    <button
      type="button"
      className={`screen-picker-card${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onSelect(item.token)}
      onDoubleClick={() => onOpen(item.token)}
      data-testid="screen-picker-card"
      data-kind={kind}
      data-token={item.token}
    >
      <span className="screen-picker-preview">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt="" draggable={false} />
        ) : (
          <span className="screen-picker-placeholder">
            {kind === 'screen' ? (
              <RiComputerLine size={30} aria-hidden="true" />
            ) : (
              <RiWindowLine size={30} aria-hidden="true" />
            )}
          </span>
        )}
        <span className="screen-picker-check" aria-hidden="true">
          <RiCheckLine size={14} />
        </span>
      </span>
      <span className="screen-picker-meta">
        {item.icon ? (
          <img className="screen-picker-icon" src={item.icon} alt="" />
        ) : kind === 'screen' ? (
          <RiComputerLine
            className="screen-picker-icon-fallback"
            size={16}
            aria-hidden="true"
          />
        ) : (
          <RiWindowLine
            className="screen-picker-icon-fallback"
            size={16}
            aria-hidden="true"
          />
        )}
        <span className="screen-picker-text">
          <strong title={item.title}>{item.title}</strong>
          {item.subtitle && <small>{item.subtitle}</small>}
        </span>
      </span>
    </button>
  )
}
