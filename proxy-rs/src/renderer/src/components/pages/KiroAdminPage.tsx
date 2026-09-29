import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, LayoutDashboard, Loader2, RefreshCw, ServerCrash } from 'lucide-react'
import { Button } from '../ui'
import { useTranslation } from '../../hooks/useTranslation'

type AdminView = Awaited<ReturnType<typeof window.api.kiroAdminView>>

/** kiro-rs 子进程已就绪的状态名（与 main/accountDb/kiroRsProcess.ts 一致） */
const KIRO_RS_RUNNING = 'running'

/**
 * 内嵌 kiro-rs 自带的 Admin 页面（凭据、号池、统计）。
 *
 * 页面由 kiro-rs 在 127.0.0.1 提供，App 用独立会话的 <webview> 加载；
 * 主进程限定只能加载这个地址，并自动写入 Admin Key，所以这里不需要登录。
 */
export function KiroAdminPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [view, setView] = useState<AdminView | null>(null)
  const webviewRef = useRef<HTMLElement & { reload: () => void }>(null)

  const load = useCallback(async () => {
    try {
      setView(await window.api.kiroAdminView())
    } catch {
      setView(null)
    }
  }, [])

  useEffect(() => {
    void load()
    // kiro-rs 启动 / 重启后自动刷新地址与状态
    return window.api.onAccountDbStatus(() => void load())
  }, [load])

  const ready = Boolean(view?.enabled && view.url && view.kiroRsState === KIRO_RS_RUNNING)

  if (!ready) {
    const starting = view?.enabled && view.kiroRsState !== 'failed'
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
        {starting ? (
          <Loader2 className="h-8 w-8 animate-spin" />
        ) : (
          <ServerCrash className="h-8 w-8" />
        )}
        <div className="text-sm">
          {!view?.enabled
            ? isEn
              ? 'Account DB mode is off; kiro-rs is not managed by this app.'
              : '未启用账号库模式，kiro-rs 不由本 App 托管。'
            : starting
              ? isEn
                ? 'kiro-rs is starting…'
                : 'kiro-rs 启动中…'
              : isEn
                ? 'kiro-rs is not running.'
                : 'kiro-rs 未在运行。'}
        </div>
        {view?.detail && <div className="text-xs max-w-lg text-center">{view.detail}</div>}
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          {isEn ? 'Retry' : '重试'}
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 text-sm">
        <LayoutDashboard className="h-4 w-4 text-primary" />
        <span className="font-medium">{isEn ? 'kiro-rs Admin' : 'kiro-rs 管理'}</span>
        <span className="type-code text-xs text-muted-foreground">{view?.url}</span>
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={isEn ? 'Reload' : '刷新'}
            onClick={() => webviewRef.current?.reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={isEn ? 'Open in browser' : '在浏览器中打开（需手动登录）'}
            onClick={() => view?.url && window.open(view.url)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <webview
        ref={webviewRef}
        src={view?.url}
        // partition 是 Electron <webview> 的属性，React 的 DOM 属性表里没有
        // eslint-disable-next-line react/no-unknown-property
        partition={view?.partition}
        className="flex-1 min-h-0 w-full"
      />
    </div>
  )
}
