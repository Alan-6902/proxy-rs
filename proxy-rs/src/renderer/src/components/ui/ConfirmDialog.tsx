import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Trash2, Info } from 'lucide-react'
import { Button } from './button'
import { registerConfirmHost, type ConfirmTone, type PendingConfirm } from './confirmDialogStore'
import { useEscapeClose } from '@/hooks/useEscapeClose'

/**
 * 应用内确认对话框宿主，替代原生 `window.confirm`。
 *
 * 原生 confirm 是同步阻塞的系统模态框：样式无法跟随主题、无法承载"后果说明"这一层信息，
 * 且在删除账号这类破坏性操作上没有视觉分级。
 *
 * 在 App 根部渲染一次本组件，之后任意位置（含非组件的事件处理函数）都可调用
 * `askConfirm()`，无需 context 或 prop 钻取。调用入口见 ./confirmDialogStore。
 */

const TONE_ICON: Record<ConfirmTone, React.ElementType> = {
  danger: Trash2,
  warning: AlertTriangle,
  default: Info
}

const TONE_ICON_CLASS: Record<ConfirmTone, string> = {
  danger: 'bg-destructive/12 text-destructive ring-destructive/25',
  warning: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 ring-amber-500/25',
  default: 'bg-primary/12 text-primary ring-primary/25'
}

export function ConfirmDialogHost(): React.ReactNode {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [holdRemaining, setHoldRemaining] = useState(0)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const locked = holdRemaining > 0

  useEffect(() => {
    registerConfirmHost((next) => {
      setPending(next)
      setHoldRemaining(next.holdToConfirmMs ? Math.ceil(next.holdToConfirmMs / 1000) : 0)
    })
    return () => registerConfirmHost(null)
  }, [])

  // 倒计时：高风险操作在若干秒内不可确认
  useEffect(() => {
    if (holdRemaining <= 0) return
    const timer = setTimeout(() => setHoldRemaining((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [holdRemaining])

  // 打开后把焦点移入对话框，让键盘用户能直接 Enter/Esc 响应。
  // 倒计时期间确认按钮是 disabled（无法聚焦），此时先落在取消按钮上；
  // 解锁后再移到确认按钮。
  useEffect(() => {
    if (!pending) return
    if (!locked) confirmButtonRef.current?.focus()
    else cancelButtonRef.current?.focus()
  }, [pending, locked])

  const settle = useCallback((result: boolean) => {
    setPending((current) => {
      current?.resolve(result)
      return null
    })
  }, [])

  // Esc 关闭走公共栈：确认框叠在其它弹窗之上时，只关自己这一层
  useEscapeClose(!!pending, () => settle(false))

  useEffect(() => {
    if (!pending) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // 焦点陷阱：Tab 只在取消/确认两个按钮间循环，不会退到对话框背后的页面
      if (event.key === 'Tab') {
        const focusable = [cancelButtonRef.current, confirmButtonRef.current].filter(
          (el): el is HTMLButtonElement => !!el && !el.disabled
        )
        if (focusable.length === 0) return
        event.preventDefault()
        const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement)
        const nextIndex = event.shiftKey
          ? currentIndex <= 0
            ? focusable.length - 1
            : currentIndex - 1
          : currentIndex === focusable.length - 1
            ? 0
            : currentIndex + 1
        focusable[nextIndex].focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, settle])

  if (!pending) return null

  const tone = pending.tone ?? 'default'
  const Icon = TONE_ICON[tone]

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={() => settle(false)} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={pending.description ? 'confirm-dialog-desc' : undefined}
        className="glass-card-strong relative w-full max-w-md overflow-hidden rounded-2xl animate-in zoom-in-95 duration-150"
      >
        <div className="flex gap-4 p-6">
          <div
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ring-1 ${TONE_ICON_CLASS[tone]}`}
          >
            <Icon className="h-5 w-5" strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="type-title text-base text-foreground">
              {pending.title}
            </h2>
            {pending.description && (
              <p
                id="confirm-dialog-desc"
                className="mt-2 text-sm leading-relaxed text-muted-foreground"
              >
                {pending.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/50 bg-black/[0.02] px-6 py-4 dark:bg-white/[0.02]">
          <Button ref={cancelButtonRef} variant="ghost" size="sm" onClick={() => settle(false)}>
            {pending.cancelText ?? '取消'}
          </Button>
          <Button
            ref={confirmButtonRef}
            variant={tone === 'danger' ? 'destructive' : 'default'}
            size="sm"
            disabled={locked}
            onClick={() => settle(true)}
          >
            {locked
              ? `${pending.confirmText ?? '确定'} (${holdRemaining})`
              : (pending.confirmText ?? '确定')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
