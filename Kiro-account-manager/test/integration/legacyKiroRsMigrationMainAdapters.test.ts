import { constants as fsConstants } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LegacyKiroRsMigrationElectronStoreSnapshot,
  LegacyKiroRsMigrationEncryptedJournal,
  LegacyKiroRsMigrationExclusiveCoordinator,
  shouldBlockLegacyKiroRsMigrationAutoStart,
  type LegacyKiroRsMigrationFileHandle,
  type LegacyKiroRsMigrationJournalFileSystem,
  type LegacyKiroRsMigrationStat
} from '../../src/main/legacyKiroRsMigrationMainAdapters'
import type { LegacyKiroRsMigrationJournal } from '../../src/main/legacyKiroRsMigrationTransaction'

const secret = 'upstream-secret-inbound-secret-admin-secret'
const proxyConfig = {
  enabled: false,
  port: 5580,
  host: '127.0.0.1',
  enableMultiAccount: false,
  selectedAccountIds: [],
  logRequests: false,
  maxConcurrent: 1
}

function journal(): LegacyKiroRsMigrationJournal {
  return {
    version: 1,
    operation: 'apply',
    state: 'prepared',
    scanId: 'scan',
    timestamps: { preparedAt: 1, updatedAt: 1 },
    before: { accountData: { accounts: {}, activeAccountId: null }, proxyConfig },
    after: {
      accountData: {
        accounts: { account: { credentials: { kiroApiKey: secret } } },
        activeAccountId: 'account'
      },
      proxyConfig: {
        ...proxyConfig,
        apiKeys: [
          {
            id: 'key',
            name: 'key',
            key: secret,
            format: 'sk',
            enabled: true,
            createdAt: 1,
            usage: {
              totalRequests: 0,
              totalCredits: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              daily: {}
            }
          }
        ],
        adminApiKey: secret
      }
    },
    beforeHash: 'before',
    afterHash: 'after',
    accountStepFingerprint: 'fingerprint',
    migratedAccountIds: ['account'],
    inboundApiKey: 'appended',
    adminApiKey: 'written'
  }
}

function fakeStorage() {
  const files = new Map<string, { data: Buffer; mode: number; symlink?: boolean }>()
  const operations: string[] = []
  const stat = (entry: {
    data: Buffer
    mode: number
    symlink?: boolean
  }): LegacyKiroRsMigrationStat => ({
    mode: entry.mode,
    size: entry.data.length,
    isFile: () => !entry.symlink,
    isSymbolicLink: () => !!entry.symlink
  })
  const fileSystem: LegacyKiroRsMigrationJournalFileSystem = {
    async lstat(filePath) {
      operations.push(`lstat:${filePath}`)
      const entry = files.get(filePath)
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return stat(entry)
    },
    async open(filePath, flags, mode) {
      operations.push(`open:${flags}:${filePath}`)
      if ((flags === 'r' || typeof flags === 'number') && filePath.endsWith('.enc')) {
        const entry = files.get(filePath)
        if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return reader(entry, operations)
      }
      if (flags === 'r') return directory(operations)
      const entry = { data: Buffer.alloc(0), mode: mode ?? 0 }
      files.set(filePath, entry)
      return writer(entry, operations)
    },
    async rename(from, to) {
      operations.push(`rename:${from}:${to}`)
      const entry = files.get(from)
      if (!entry) throw new Error('missing temp')
      files.set(to, entry)
      files.delete(from)
    }
  }
  return { fileSystem, files, operations }
}

function reader(
  entry: { data: Buffer; mode: number; symlink?: boolean },
  operations: string[]
): LegacyKiroRsMigrationFileHandle {
  return {
    async chmod() {
      throw new Error('read-only')
    },
    async close() {
      operations.push('close')
    },
    async read(buffer, offset, length) {
      entry.data.copy(buffer, offset, 0, length)
      return { bytesRead: entry.data.length }
    },
    async stat() {
      return {
        mode: entry.mode,
        size: entry.data.length,
        isFile: () => !entry.symlink,
        isSymbolicLink: () => !!entry.symlink
      }
    },
    async sync() {
      operations.push('sync')
    },
    async truncate() {
      throw new Error('read-only')
    },
    async write() {
      throw new Error('read-only')
    }
  }
}

function writer(
  entry: { data: Buffer; mode: number },
  operations: string[]
): LegacyKiroRsMigrationFileHandle {
  return {
    async chmod(mode) {
      operations.push(`chmod:${mode}`)
      entry.mode = mode
    },
    async close() {
      operations.push('close')
    },
    async read() {
      return { bytesRead: 0 }
    },
    async stat() {
      return {
        mode: entry.mode,
        size: entry.data.length,
        isFile: () => true,
        isSymbolicLink: () => false
      }
    },
    async sync() {
      operations.push('sync')
    },
    async truncate() {
      operations.push('truncate')
      entry.data = Buffer.alloc(0)
    },
    async write(buffer, offset = 0, length = buffer.length) {
      operations.push('write')
      entry.data = Buffer.from(buffer.subarray(offset, offset + length))
      return { bytesWritten: length }
    }
  }
}

function directory(operations: string[]): LegacyKiroRsMigrationFileHandle {
  return {
    async chmod() {},
    async close() {
      operations.push('dir-close')
    },
    async read() {
      return { bytesRead: 0 }
    },
    async stat() {
      return { mode: 0o700, size: 0, isFile: () => false, isSymbolicLink: () => false }
    },
    async sync() {
      operations.push('dir-sync')
    },
    async truncate() {},
    async write() {
      return { bytesWritten: 0 }
    }
  }
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => {
    const text = value.toString()
    if (!text.startsWith('cipher:')) throw new Error('tampered')
    return Buffer.from(text.slice('cipher:'.length), 'base64').toString()
  }
}

describe('Legacy Kiro RS main adapters', () => {
  it('retries a unique O_EXCL journal temp path, including the tombstone write path', async () => {
    const fake = fakeStorage()
    const open = fake.fileSystem.open.bind(fake.fileSystem)
    const tempPaths: string[] = []
    let eexistCount = 0
    fake.fileSystem.open = async (filePath, flags, mode) => {
      if (typeof flags === 'number' && filePath.endsWith('.tmp')) {
        tempPaths.push(filePath)
        if (eexistCount++ === 0) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
      return open(filePath, flags, mode)
    }
    const adapter = new LegacyKiroRsMigrationEncryptedJournal(
      '/state/kiro-accounts.json',
      safeStorage,
      fake.fileSystem
    )

    await adapter.write(journal())
    await adapter.remove()

    expect(tempPaths).toHaveLength(3)
    expect(new Set(tempPaths).size).toBe(3)
    const tempOpenFlags = fake.operations
      .filter((operation) => operation.startsWith('open:') && operation.endsWith('.tmp'))
      .map((operation) => Number(operation.split(':')[1]))
    expect(tempOpenFlags).toEqual(expect.arrayContaining([expect.any(Number)]))
    expect(
      tempOpenFlags.every((flags) => (flags & fsConstants.O_EXCL) === fsConstants.O_EXCL)
    ).toBe(true)
    expect(fake.files.has('/state/legacy-kiro-rs-migration.v1.enc')).toBe(true)
    expect(await adapter.read()).toBeUndefined()
  })

  it('fails closed after four O_EXCL temp collisions without replacing the committed journal', async () => {
    const fake = fakeStorage()
    const open = fake.fileSystem.open.bind(fake.fileSystem)
    const tempPaths: string[] = []
    fake.fileSystem.open = async (filePath, flags, mode) => {
      if (typeof flags === 'number' && filePath.endsWith('.tmp')) {
        tempPaths.push(filePath)
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
      return open(filePath, flags, mode)
    }
    const adapter = new LegacyKiroRsMigrationEncryptedJournal(
      '/state/kiro-accounts.json',
      safeStorage,
      fake.fileSystem
    )

    await expect(adapter.write(journal())).rejects.toMatchObject({ code: 'WRITE_FAILED' })

    expect(tempPaths).toHaveLength(4)
    expect(new Set(tempPaths).size).toBe(4)
    expect(fake.files.has('/state/legacy-kiro-rs-migration.v1.enc')).toBe(false)
  })

  it('encrypts journal/tombstone atomically without plaintext secrets and returns deep copies', async () => {
    const fake = fakeStorage()
    const adapter = new LegacyKiroRsMigrationEncryptedJournal(
      '/state/kiro-accounts.json',
      safeStorage,
      fake.fileSystem
    )
    await adapter.write(journal())
    const raw = [...fake.files.values()][0].data.toString()
    expect(raw).not.toContain(secret)
    expect(fake.operations).toEqual(
      expect.arrayContaining(['chmod:384', 'truncate', 'write', 'sync', 'dir-sync'])
    )
    const loaded = await adapter.read()
    expect(loaded).toEqual(journal())
    ;(
      loaded!.after.accountData.accounts.account as { credentials: { kiroApiKey: string } }
    ).credentials.kiroApiKey = 'changed'
    expect(
      (
        (await adapter.read())!.after.accountData.accounts.account as {
          credentials: { kiroApiKey: string }
        }
      ).credentials.kiroApiKey
    ).toBe(secret)
    await adapter.remove()
    expect(await adapter.read()).toBeUndefined()
  })

  it('does zero filesystem writes when encryption is unavailable', async () => {
    const fake = fakeStorage()
    const adapter = new LegacyKiroRsMigrationEncryptedJournal(
      '/state/kiro-accounts.json',
      { ...safeStorage, isEncryptionAvailable: () => false },
      fake.fileSystem
    )
    await expect(adapter.write(journal())).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
    await expect(adapter.read()).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
    expect(fake.operations).toEqual([])
  })

  it('fails closed on Linux basic_text, unknown, or absent secure-storage backends', async () => {
    for (const backend of ['basic_text', 'unknown', undefined]) {
      const fake = fakeStorage()
      const adapter = new LegacyKiroRsMigrationEncryptedJournal(
        '/state/kiro-accounts.json',
        backend === undefined
          ? safeStorage
          : { ...safeStorage, getSelectedStorageBackend: () => backend },
        fake.fileSystem,
        'linux'
      )
      await expect(adapter.write(journal())).rejects.toMatchObject({
        code: 'ENCRYPTION_UNAVAILABLE'
      })
      expect(fake.operations).toEqual([])
    }
  })

  it('rejects tampered, unsafe, and oversized journals without revealing stored contents', async () => {
    const fake = fakeStorage()
    const adapter = new LegacyKiroRsMigrationEncryptedJournal(
      '/state/kiro-accounts.json',
      safeStorage,
      fake.fileSystem
    )
    await adapter.write(journal())
    const [, entry] = [...fake.files.entries()][0]
    entry.data = Buffer.from('not-cipher')
    await expect(adapter.read()).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
    entry.data = safeStorage.encryptString('{}')
    await expect(adapter.read()).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
    entry.data = safeStorage.encryptString(JSON.stringify(journal()))
    entry.mode = 0o644
    await expect(adapter.read()).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
    entry.mode = 0o600
    entry.symlink = true
    await expect(adapter.read()).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
    entry.symlink = false
    entry.data = Buffer.alloc(1024 * 1024 + 1)
    await expect(adapter.read()).rejects.toMatchObject({ code: 'JOURNAL_INVALID' })
  })

  it('clones Electron Store snapshots and synchronizes lastSavedData after account writes', async () => {
    const values: Record<string, unknown> = {
      accountData: { accounts: {}, activeAccountId: null },
      proxyConfig: { apiKeys: [] }
    }
    let lastSaved: unknown
    const snapshot = new LegacyKiroRsMigrationElectronStoreSnapshot(
      {
        path: '/state/store.json',
        get: (key) => values[key],
        set: (key, value) => {
          values[key] = value
        }
      },
      (value) => {
        lastSaved = value
      }
    )
    const initial = await snapshot.read()
    initial.accountData.activeAccountId = 'mutated'
    expect((await snapshot.read()).accountData.activeAccountId).toBeNull()
    await snapshot.writeAccountData({
      accounts: { a: { credentials: { kiroApiKey: secret } } },
      activeAccountId: 'a'
    })
    await snapshot.syncLastSavedData()
    expect(lastSaved).toEqual(values.accountData)
    expect(lastSaved).not.toBe(values.accountData)
  })

  it('serializes writers and blocks only unsafe startup recovery outcomes', async () => {
    const coordinator = new LegacyKiroRsMigrationExclusiveCoordinator()
    const events: string[] = []
    let release!: () => void
    const first = coordinator.runExclusive(async () => {
      events.push('first')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      events.push('first-done')
    })
    const second = coordinator.runExclusive(async () => {
      events.push('second')
    })
    await Promise.resolve()
    expect(events).toEqual(['first'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first', 'first-done', 'second'])
    expect(shouldBlockLegacyKiroRsMigrationAutoStart('manual_intervention')).toBe(true)
    expect(shouldBlockLegacyKiroRsMigrationAutoStart('JOURNAL_INVALID')).toBe(true)
    expect(shouldBlockLegacyKiroRsMigrationAutoStart('ENCRYPTION_UNAVAILABLE')).toBe(true)
    expect(shouldBlockLegacyKiroRsMigrationAutoStart('recovered')).toBe(false)
  })
})
