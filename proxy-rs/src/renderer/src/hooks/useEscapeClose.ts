/**
 * useEscapeClose hook
 * 让手写的模态弹窗/抽屉支持按 Esc 关闭
 */

import { useEffect, useRef } from 'react'

type EscapeHandlerRef = { current: () => void }

/**
 * Esc 关闭栈：同一时刻可能叠着多层（弹窗里再弹确认框），
 * 只让最后注册的那一层响应 Escape，避免一次按键把整叠弹窗全关掉。
 */
const escapeStack: EscapeHandlerRef[] = []

function handleKeyDown(event: KeyboardEvent): void {
  // defaultPrevented：Escape 已被更内层的控件（如正在编辑的输入框）处理过，不再关弹窗
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const top = escapeStack[escapeStack.length - 1]
  if (!top) return
  event.preventDefault()
  top.current()
}

/**
 * 弹窗打开期间监听 Escape，按下时调用 onClose。
 *
 * @param active 弹窗是否打开（关闭时自动摘掉监听）
 * @param onClose Esc 时执行的关闭逻辑，无需自己保持引用稳定
 */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  // 存进 ref：effect 只依赖 active，内联箭头函数导致的重渲染不会把本层重新顶到栈顶
  const handlerRef = useRef(onClose)
  handlerRef.current = onClose

  useEffect(() => {
    if (!active) return
    escapeStack.push(handlerRef)
    if (escapeStack.length === 1) window.addEventListener('keydown', handleKeyDown)
    return () => {
      const index = escapeStack.indexOf(handlerRef)
      if (index !== -1) escapeStack.splice(index, 1)
      if (escapeStack.length === 0) window.removeEventListener('keydown', handleKeyDown)
    }
  }, [active])
}
