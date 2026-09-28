import { describe, expect, it, vi } from 'vitest'
import { startManagedAccountRefresh } from '../../src/main/adminManaged/startup'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('刷新调度等待托管初始化', () => {
  it('加载未完成不认领，认领未完成不启动任何刷新', async () => {
    const loaded = deferred()
    const adopted = deferred()
    const adopt = vi.fn(() => adopted.promise)
    const start = vi.fn()
    const initializing = startManagedAccountRefresh({ reload: () => loaded.promise, adopt, start })
    expect(adopt).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    loaded.resolve()
    await Promise.resolve()
    expect(adopt).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    adopted.resolve()
    await initializing
    expect(start).toHaveBeenCalledOnce()
  })

  it.each(['reload', 'adopt'] as const)('%s 失败时不启动刷新', async (failing) => {
    const start = vi.fn()
    const steps = { reload: async () => {}, adopt: async () => {}, start }
    steps[failing] = async () => {
      throw new Error('not ready')
    }
    await expect(startManagedAccountRefresh(steps)).rejects.toThrow('not ready')
    expect(start).not.toHaveBeenCalled()
  })
})
