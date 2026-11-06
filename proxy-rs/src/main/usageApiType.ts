import { ipcMain } from 'electron'
import { IPC } from '../shared/ipcChannels'

/**
 * 用量查询走哪种上游接口：REST（GetUsageLimits）或 CBOR。
 * 设置页通过 IPC 读写，值持久化在 electron-store 的 `usageApiType` 键。
 */
export type UsageApiType = 'rest' | 'cbor'

export const DEFAULT_USAGE_API_TYPE: UsageApiType = 'rest'
export const USAGE_API_TYPE_STORE_KEY = 'usageApiType'

interface UsageApiTypeStore {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

let currentUsageApiType: UsageApiType = DEFAULT_USAGE_API_TYPE

export function isUsageApiType(value: unknown): value is UsageApiType {
  return value === 'rest' || value === 'cbor'
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

/** 启动时从 store 恢复上次保存的值；值非法或缺失时保持默认。 */
export function restoreUsageApiType(store: UsageApiTypeStore): void {
  const saved = store.get(USAGE_API_TYPE_STORE_KEY)
  if (isUsageApiType(saved)) setUsageApiType(saved)
}

export function registerUsageApiTypeIpcHandlers(getStore: () => UsageApiTypeStore | null): void {
  ipcMain.handle(IPC.getUsageApiType, () => getUsageApiType())

  ipcMain.handle(IPC.setUsageApiType, (_event, type: unknown) => {
    if (!isUsageApiType(type)) {
      throw new Error(`无效的 Usage API 类型：${String(type)}`)
    }
    setUsageApiType(type)
    getStore()?.set(USAGE_API_TYPE_STORE_KEY, type)
    return { success: true, type }
  })
}
