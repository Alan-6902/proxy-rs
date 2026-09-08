import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../ui'
import { cn } from '@/lib/utils'
import { useEscapeClose } from '@/hooks/useEscapeClose'

interface CursorDialogShellProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  icon?: React.ElementType
  /** 标题右侧的小徽标或计数。 */
  badge?: React.ReactNode
  footer?: React.ReactNode
  widthClassName?: string
  children: React.ReactNode
}

/** Cursor 页几个弹窗共用的外壳，结构与账户页的导出弹窗一致：遮罩 + 标题栏 + 内容 + 底栏。 */
export function CursorDialogShell({
  open,
  onClose,
  title,
  icon: Icon,
  badge,
  footer,
  widthClassName = 'w-[520px]',
  children
}: CursorDialogShellProps): React.ReactNode {
  useEscapeClose(open, onClose)
  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative max-h-[85vh] flex flex-col bg-background rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200',
          widthClassName
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="h-5 w-5" />}
            <h2 className="text-lg font-semibold">{title}</h2>
            {badge}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
        {footer && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  )
}
