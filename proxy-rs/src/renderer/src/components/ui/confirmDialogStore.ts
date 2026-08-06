/**
 * 应用内确认框的命令式入口，与 <ConfirmDialogHost /> 组件分离。
 *
 * 拆成独立模块的原因：同一文件里既导出组件又导出普通函数会破坏 Fast Refresh
 * （react-refresh/only-export-components）。
 */

export type ConfirmTone = 'danger' | 'warning' | 'default'

export interface ConfirmOptions {
  /** 主问句，说明将要发生什么。 */
  title: string
  /** 后果说明：不可恢复、影响范围等。原生 confirm 无法承载这一层。 */
  description?: string
  confirmText?: string
  cancelText?: string
  /** danger 用于不可恢复的破坏性操作（删除、清空）。 */
  tone?: ConfirmTone
  /** 需要冷静期的高风险操作：确认按钮在指定毫秒内不可点击。 */
  holdToConfirmMs?: number
}

export interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

/** host 注册的打开函数；未挂载时为 null。 */
let openConfirm: ((pending: PendingConfirm) => void) | null = null

/** 由 <ConfirmDialogHost /> 在挂载/卸载时调用。 */
export function registerConfirmHost(handler: ((pending: PendingConfirm) => void) | null): void {
  openConfirm = handler
}

/**
 * 弹出确认框并等待用户选择，resolve(true) 表示确认。
 *
 * 用于替代原生 `window.confirm`：
 *   if (!confirm('删除？')) return
 *   → if (!(await askConfirm({ title: '删除？' }))) return
 *
 * host 未挂载时回退到原生 confirm，保证破坏性操作不会静默通过。
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  if (!openConfirm) {
    return Promise.resolve(
      window.confirm([options.title, options.description].filter(Boolean).join('\n\n'))
    )
  }
  return new Promise<boolean>((resolve) => {
    openConfirm!({ ...options, resolve })
  })
}
