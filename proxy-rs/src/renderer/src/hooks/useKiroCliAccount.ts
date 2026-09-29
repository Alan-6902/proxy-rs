import { useSyncExternalStore } from 'react'

/**
 * Kiro CLI 当前登录的账号（账号库模式下该账号由 kiro-cli 自己刷新，kiro-rs 不刷新它）。
 *
 * 账号卡片很多，这里做成模块级单例：首次订阅时查询一次、挂一个变更监听，所有卡片共用。
 */
let currentAccountId: string | null = null
let started = false
const listeners = new Set<() => void>()

function emit(next: string | null): void {
  if (next === currentAccountId) return
  currentAccountId = next
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  window.api.onKiroCliAccountChanged(({ accountId }) => emit(accountId))
  void window.api
    .kiroCliCurrentAccount()
    .then(({ accountId }) => emit(accountId))
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useKiroCliAccountId(): string | null {
  return useSyncExternalStore(subscribe, () => currentAccountId)
}
