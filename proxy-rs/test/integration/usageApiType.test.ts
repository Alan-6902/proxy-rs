import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import {
  DEFAULT_USAGE_API_TYPE,
  USAGE_API_TYPE_IPC,
  USAGE_API_TYPE_STORE_KEY,
  getUsageApiType,
  registerUsageApiTypeIpcHandlers,
  restoreUsageApiType,
  setUsageApiType
} from '../../src/main/usageApiType'

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('electron', () => electron)

const event = {} as IpcMainInvokeEvent

function handler(channel: string): (...args: unknown[]) => unknown {
  return electron.ipcMain.handle.mock.calls.find(([name]) => name === channel)![1]
}

function memoryStore(initial: Record<string, unknown> = {}): {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  data: Record<string, unknown>
} {
  const data = { ...initial }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setUsageApiType(DEFAULT_USAGE_API_TYPE)
})

describe('Usage API 类型 IPC', () => {
  it('设置页读写的两个通道都有 handler（回归：曾被整体删除）', () => {
    registerUsageApiTypeIpcHandlers(() => null)
    const channels = electron.ipcMain.handle.mock.calls.map(([name]) => name)
    expect(channels).toEqual([USAGE_API_TYPE_IPC.get, USAGE_API_TYPE_IPC.set])
  })

  it('set 会更新内存值并持久化到 store，get 读回同一值', () => {
    const store = memoryStore()
    registerUsageApiTypeIpcHandlers(() => store)

    expect(handler(USAGE_API_TYPE_IPC.set)(event, 'cbor')).toEqual({ success: true, type: 'cbor' })
    expect(getUsageApiType()).toBe('cbor')
    expect(store.data[USAGE_API_TYPE_STORE_KEY]).toBe('cbor')
    expect(handler(USAGE_API_TYPE_IPC.get)(event)).toBe('cbor')
  })

  it('非法值被拒绝且不改动当前值', () => {
    const store = memoryStore()
    registerUsageApiTypeIpcHandlers(() => store)

    expect(() => handler(USAGE_API_TYPE_IPC.set)(event, 'grpc')).toThrow(/无效/)
    expect(getUsageApiType()).toBe(DEFAULT_USAGE_API_TYPE)
    expect(store.data[USAGE_API_TYPE_STORE_KEY]).toBeUndefined()
  })

  it('启动时从 store 恢复，非法存量值回退默认', () => {
    restoreUsageApiType(memoryStore({ [USAGE_API_TYPE_STORE_KEY]: 'cbor' }))
    expect(getUsageApiType()).toBe('cbor')

    setUsageApiType(DEFAULT_USAGE_API_TYPE)
    restoreUsageApiType(memoryStore({ [USAGE_API_TYPE_STORE_KEY]: 'bogus' }))
    expect(getUsageApiType()).toBe(DEFAULT_USAGE_API_TYPE)
  })
})
