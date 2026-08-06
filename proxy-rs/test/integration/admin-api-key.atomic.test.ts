import { describe, expect, it } from 'vitest'
import { ADMIN_KEY_UPDATE_ERROR, switchAdminApiKey } from '../../src/main/proxy/adminApiKey'

interface Config {
  adminApiKey?: string
  marker: string
}

describe('管理员密钥原子切换', () => {
  const previous: Config = { adminApiKey: 'old-admin', marker: 'preserved' }

  it('持久化成功后更新运行时并返回成功', () => {
    const writes: Config[] = []
    const updates: Array<string | undefined> = []
    const calls: string[] = []
    const result = switchAdminApiKey(
      previous,
      'new-admin',
      {
        write: (value) => {
          writes.push(value)
          calls.push(`persist:${value.adminApiKey}`)
        }
      },
      {
        update: (value) => {
          updates.push(value)
          calls.push(`runtime:${value}`)
        }
      }
    )
    expect(result).toEqual({ success: true })
    expect(writes).toEqual([{ adminApiKey: 'new-admin', marker: 'preserved' }])
    expect(updates).toEqual(['new-admin'])
    expect(calls).toEqual(['persist:new-admin', 'runtime:new-admin'])
  })

  it('首次持久化失败时运行时保持不变', () => {
    const updates: Array<string | undefined> = []
    const result = switchAdminApiKey(
      previous,
      'new-admin',
      {
        write: () => {
          throw new Error('disk')
        }
      },
      { update: (value) => updates.push(value) }
    )
    expect(result).toEqual({ success: false, error: ADMIN_KEY_UPDATE_ERROR })
    expect(updates).toEqual([])
  })

  it('运行时失败时回滚持久化与运行时旧值', () => {
    const writes: Config[] = []
    const updates: Array<string | undefined> = []
    const calls: string[] = []
    const result = switchAdminApiKey(
      previous,
      'new-admin',
      {
        write: (value) => {
          writes.push(value)
          calls.push(`persist:${value.adminApiKey}`)
        }
      },
      {
        update: (value) => {
          updates.push(value)
          calls.push(`runtime:${value}`)
          if (value === 'new-admin') throw new Error('runtime')
        }
      }
    )
    expect(result).toEqual({ success: false, error: ADMIN_KEY_UPDATE_ERROR })
    expect(writes).toEqual([{ adminApiKey: 'new-admin', marker: 'preserved' }, previous])
    expect(updates).toEqual(['new-admin', 'old-admin'])
    expect(calls).toEqual([
      'persist:new-admin',
      'runtime:new-admin',
      'persist:old-admin',
      'runtime:old-admin'
    ])
  })

  it('回滚再失败时仍只返回泛化错误', () => {
    let writeCount = 0
    const updates: Array<string | undefined> = []
    const result = switchAdminApiKey(
      previous,
      'new-admin',
      {
        write: () => {
          writeCount++
          if (writeCount > 1) throw new Error('rollback disk')
        }
      },
      {
        update: (value) => {
          updates.push(value)
          throw new Error('runtime')
        }
      }
    )
    expect(result).toEqual({ success: false, error: ADMIN_KEY_UPDATE_ERROR })
    expect(updates).toEqual(['new-admin', 'old-admin'])
  })
})
