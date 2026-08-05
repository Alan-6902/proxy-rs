import { constants } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LegacyKiroRsMigrationService,
  type LegacyKiroRsMigrationFileSystem,
  type LegacyKiroRsMigrationTargetSnapshot
} from '../../src/main/legacyKiroRsMigration'
import { LEGACY_KIRO_RS_MIGRATION_ERROR_CODES } from '../../src/shared/legacyKiroRsMigration'

const HOME = '/fake-home'
const CONFIG_DIR = `${HOME}/kiro-rs/config`
const CONFIG_PATH = `${CONFIG_DIR}/config.json`
const CREDENTIALS_PATH = `${CONFIG_DIR}/credentials.json`
const UID = 501

type Entry = {
  bytes?: Buffer
  type?: 'directory' | 'file' | 'symlink'
  uid?: number
  mode?: number
  dev?: number
  ino?: number
  mtimeMs?: number
  ctimeMs?: number
  realpath?: string
  maxReadBytes?: number
  openStat?: Partial<Pick<Entry, 'type' | 'uid' | 'mode' | 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'>>
  mutateAfterRead?: boolean
}

function makeStat(entry: Entry, fallbackIno: number, overrides: Entry['openStat'] = {}) {
  const merged = { ...entry, ...overrides }
  const type = merged.type ?? 'file'
  return {
    uid: merged.uid ?? UID,
    mode: merged.mode ?? 0o600,
    dev: merged.dev ?? 1,
    ino: merged.ino ?? fallbackIno,
    size: entry.bytes?.length ?? 0,
    mtimeMs: merged.mtimeMs ?? 1,
    ctimeMs: merged.ctimeMs ?? 1,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink'
  }
}

function makeFileSystem(overrides: Partial<Record<string, Entry>> = {}) {
  const entries: Record<string, Entry> = {
    [CONFIG_DIR]: { type: 'directory', mode: 0o700 },
    [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({})) },
    [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([])) },
    ...overrides
  }
  const calls: string[] = []
  const requireEntry = (filePath: string): Entry => {
    const entry = entries[filePath]
    if (!entry) throw new Error('missing')
    return entry
  }
  const fileSystem: LegacyKiroRsMigrationFileSystem = {
    async lstat(filePath) {
      calls.push(`lstat:${filePath}`)
      return makeStat(requireEntry(filePath), Object.keys(entries).indexOf(filePath) + 1)
    },
    async realpath(filePath) {
      calls.push(`realpath:${filePath}`)
      const entry = requireEntry(filePath)
      return entry.realpath ?? filePath
    },
    async open(filePath, flags) {
      calls.push(`open:${filePath}`)
      expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW)
      const entry = requireEntry(filePath)
      let afterRead = false
      let cursor = 0
      return {
        async stat() {
          const stat = makeStat(entry, Object.keys(entries).indexOf(filePath) + 1, entry.openStat)
          return afterRead && entry.mutateAfterRead ? { ...stat, mtimeMs: stat.mtimeMs + 1 } : stat
        },
        async read(buffer, offset, length) {
          calls.push(`read:${filePath}`)
          const bytes = entry.bytes ?? Buffer.alloc(0)
          const bytesRead = bytes.copy(buffer, offset, cursor, cursor + Math.min(length, entry.maxReadBytes ?? length))
          cursor += bytesRead
          afterRead = true
          return { bytesRead }
        },
        async close() {
          calls.push(`close:${filePath}`)
        }
      }
    }
  }
  return { entries, fileSystem, calls }
}

function makeService(options: {
  entries?: Partial<Record<string, Entry>>
  target?: Partial<LegacyKiroRsMigrationTargetSnapshot>
  readTargetSnapshot?: () => Promise<LegacyKiroRsMigrationTargetSnapshot>
  now?: () => number
  randomBytes?: (size: number) => Buffer
  isPosixPlatform?: () => boolean
  scheduleExpiration?: (callback: () => void, delayMs: number) => { unref?: () => void }
  clearExpiration?: (timer: { unref?: () => void }) => void
} = {}) {
  const fake = makeFileSystem(options.entries)
  let randomCounter = 0
  const service = new LegacyKiroRsMigrationService({
    fileSystem: fake.fileSystem,
    homeDirectory: HOME,
    currentUid: UID,
    now: options.now ?? (() => 1_000),
    randomBytes: options.randomBytes ?? (size => Buffer.alloc(size, ++randomCounter)),
    isPosixPlatform: options.isPosixPlatform,
    scheduleExpiration: options.scheduleExpiration,
    clearExpiration: options.clearExpiration,
    readTargetSnapshot: options.readTargetSnapshot ?? (async () => ({ upstreamKiroApiKeys: [], ...options.target }))
  })
  return { service, ...fake }
}

async function expectMigrationError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('LegacyKiroRsMigrationService', () => {
  it('previews valid credentials without exposing secrets and only reads fixed paths', async () => {
    const upstreamKey = 'kiro-secret-upstream-key'
    const inboundKey = 'inbound-secret-key'
    const adminKey = 'admin-secret-key'
    const { service, calls } = makeService({
      entries: {
        [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ apiKey: inboundKey, adminApiKey: adminKey, proxyUrl: 'http://ignored', tls: true })) },
        [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([{ kiroApiKey: upstreamKey }])) }
      },
      target: { apiKey: inboundKey, adminApiKey: 'other-admin-key' }
    })

    const preview = await service.scan()

    expect(preview.accounts).toMatchObject({ available: 1, new: 1, existing: 0, duplicate: 0 })
    expect(preview.settings).toEqual({
      apiKey: { state: 'matches' },
      adminApiKey: { state: 'conflict' },
      unsupportedCount: 2
    })
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain(upstreamKey)
    expect(serialized).not.toContain(inboundKey)
    expect(serialized).not.toContain(adminKey)
    expect(calls.filter(call => call.startsWith('read:'))).toEqual([`read:${CONFIG_PATH}`, `read:${CONFIG_PATH}`, `read:${CREDENTIALS_PATH}`, `read:${CREDENTIALS_PATH}`])
    expect(calls.every(call => !call.includes('.bak') && !call.includes('cache') && !call.includes('stats'))).toBe(true)
  })

  it('classifies existing target keys and duplicate source keys in bounded linear work', async () => {
    let iteratorCalls = 0
    const existing = 'existing-key'
    const generatedKeys = {
      *[Symbol.iterator]() {
        iteratorCalls += 1
        yield existing
        yield 'target-new-key'
      }
    }
    const { service } = makeService({
      entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([{ kiroApiKey: existing }, { kiroApiKey: existing }, { kiroApiKey: 'new-key' }])) } },
      target: { upstreamKiroApiKeys: generatedKeys }
    })
    await expect(service.scan()).resolves.toMatchObject({
      accounts: { available: 3, existing: 1, duplicate: 1, new: 1, items: [{ state: 'existing' }, { state: 'duplicate' }, { state: 'new' }] }
    })
    expect(iteratorCalls).toBe(1)
  })

  it('bounds large credentials and target generators without consuming them twice', async () => {
    let iteratorCalls = 0
    const targetKeys = {
      *[Symbol.iterator]() {
        iteratorCalls += 1
        for (let index = 0; index < 1_000; index += 1) yield `target-${index}`
      }
    }
    const credentials = Array.from({ length: 1_000 }, (_, index) => ({ kiroApiKey: `source-${index}` }))
    const { service } = makeService({
      entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify(credentials)) } },
      target: { upstreamKiroApiKeys: targetKeys }
    })
    await expect(service.scan()).resolves.toMatchObject({ accounts: { available: 1_000, new: 1_000 } })
    expect(iteratorCalls).toBe(1)

    let yielded = 0
    let closed = false
    const tooManyTargets = {
      *[Symbol.iterator]() {
        try {
          for (let index = 0; index < 10_000; index += 1) {
            yielded += 1
            yield `target-${index}`
          }
        } finally {
          closed = true
        }
      }
    }
    const tooMany = makeService({ target: { upstreamKiroApiKeys: tooManyTargets } })
    await expectMigrationError(tooMany.service.scan(), LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
    expect(yielded).toBe(1_001)
    expect(closed).toBe(true)
  })

  it('rejects unsupported platforms before filesystem access', async () => {
    const { service, calls } = makeService({ isPosixPlatform: () => false })
    await expectMigrationError(service.scan(), LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.UNSUPPORTED_PLATFORM)
    expect(calls).toEqual([])
  })

  it('rejects missing, unsafe or redirected directories and files', async () => {
    const directoryViolations: Array<Partial<Record<string, Entry>>> = [
      { [CONFIG_DIR]: undefined },
      { [CONFIG_DIR]: { type: 'symlink', mode: 0o700 } },
      { [CONFIG_DIR]: { type: 'directory', uid: UID + 1, mode: 0o700 } },
      { [CONFIG_DIR]: { type: 'directory', mode: 0o777 } },
      { [CONFIG_DIR]: { type: 'directory', mode: 0o700, realpath: '/elsewhere/config' } }
    ]
    for (const entries of directoryViolations) {
      await expectMigrationError(makeService({ entries }).service.scan(), LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_DIRECTORY_UNSAFE)
    }

    const fileViolations: Array<{ entries: Partial<Record<string, Entry>>; code: string }> = [
      { entries: { [CONFIG_PATH]: undefined }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_MISSING },
      { entries: { [CONFIG_PATH]: { type: 'directory', bytes: Buffer.from('{}') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE },
      { entries: { [CONFIG_PATH]: { type: 'symlink', bytes: Buffer.from('{}') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE },
      { entries: { [CREDENTIALS_PATH]: { uid: UID + 1, bytes: Buffer.from('[]') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE },
      { entries: { [CONFIG_PATH]: { mode: 0o664, bytes: Buffer.from('{}') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE },
      { entries: { [CREDENTIALS_PATH]: { realpath: '/elsewhere/credentials.json', bytes: Buffer.from('[]') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE }
    ]
    for (const { entries, code } of fileViolations) {
      await expectMigrationError(makeService({ entries }).service.scan(), code)
    }
  })

  it('uses bounded reads and rejects oversized, pre-open and post-read changes', async () => {
    await expectMigrationError(
      makeService({ entries: { [CONFIG_PATH]: { bytes: Buffer.alloc(256 * 1024 + 1) } } }).service.scan(),
      LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_TOO_LARGE
    )
    await expectMigrationError(
      makeService({ entries: { [CREDENTIALS_PATH]: { bytes: Buffer.alloc(8 * 1024 * 1024 + 1) } } }).service.scan(),
      LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_TOO_LARGE
    )
    const partial = makeService({ entries: { [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ apiKey: 'partial-read' })), maxReadBytes: 2 } } })
    await expect(partial.service.scan()).resolves.toMatchObject({ settings: { apiKey: { state: 'target_empty' } } })
    expect(partial.calls.filter(call => call === `read:${CONFIG_PATH}`).length).toBeGreaterThan(2)
    await expectMigrationError(
      makeService({ entries: { [CONFIG_PATH]: { bytes: Buffer.from('{}'), openStat: { ctimeMs: 2 } } } }).service.scan(),
      LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_CHANGED
    )
    await expectMigrationError(
      makeService({ entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from('[]'), mutateAfterRead: true } } }).service.scan(),
      LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_CHANGED
    )
  })

  it('rejects invalid utf8 and invalid config or credential schemas', async () => {
    const nested = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: 'too-deep' } } } } } } } })
    const cases: Array<{ entries: Partial<Record<string, Entry>>; code: string }> = [
      { entries: { [CONFIG_PATH]: { bytes: Buffer.from([0xff]) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_JSON_INVALID },
      { entries: { [CONFIG_PATH]: { bytes: Buffer.from('[]') } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CONFIG_PATH]: { bytes: Buffer.from(nested) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ apiKey: '' })) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ adminApiKey: false })) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([null])) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify({})) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID },
      { entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([{ kiroApiKey: 1 }])) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_CREDENTIAL_INVALID },
      { entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([{ kiroApiKey: 'é'.repeat(2_049) }])) } }, code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_CREDENTIAL_INVALID }
    ]
    for (const testCase of cases) {
      await expectMigrationError(makeService({ entries: testCase.entries }).service.scan(), testCase.code)
    }
  })

  it('consumes a prepared plan once and rejects source or target drift', async () => {
    const source = makeService({ entries: { [CREDENTIALS_PATH]: { bytes: Buffer.from(JSON.stringify([{ kiroApiKey: 'source-key' }])) } } })
    const sourcePreview = await source.service.scan()
    source.entries[CONFIG_PATH].bytes = Buffer.from(JSON.stringify({ apiKey: 'changed-key' }))
    await expectMigrationError(source.service.consumePreparedPlanForApply(sourcePreview.scanId), LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.STALE_SCAN)
    await expect(source.service.consumePreparedPlanForApply(sourcePreview.scanId)).resolves.toBeUndefined()

    let targetKey = 'target-one'
    const target = makeService({ readTargetSnapshot: async () => ({ upstreamKiroApiKeys: [targetKey] }) })
    const targetPreview = await target.service.scan()
    targetKey = 'target-two'
    await expectMigrationError(target.service.consumePreparedPlanForApply(targetPreview.scanId), LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.STALE_SCAN)
  })

  it('replaces previous scans and actively clears expired plans with unref timers', async () => {
    let expiration: (() => void) | undefined
    let scheduledDelay: number | undefined
    let unrefCalls = 0
    let cleared = 0
    const { service } = makeService({
      scheduleExpiration: (callback, delayMs) => {
        expiration = callback
        scheduledDelay = delayMs
        return { unref: () => { unrefCalls += 1 } }
      },
      clearExpiration: () => { cleared += 1 }
    })
    const first = await service.scan()
    expect(first.expiresAt).toBe(601_000)
    expect(scheduledDelay).toBe(600_000)
    const second = await service.scan()
    await expect(service.consumePreparedPlanForApply(first.scanId)).resolves.toBeUndefined()
    expect(unrefCalls).toBe(2)
    expect(cleared).toBeGreaterThanOrEqual(1)
    expiration?.()
    await expect(service.consumePreparedPlanForApply(second.scanId)).resolves.toBeUndefined()
  })

  it('compares Unicode setting values through fixed-length hashes', async () => {
    const { service } = makeService({
      entries: { [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ apiKey: 'é' })) } },
      target: { apiKey: '€' }
    })
    await expect(service.scan()).resolves.toMatchObject({ settings: { apiKey: { state: 'conflict' } } })
  })

  it('does not retain a plan when preview construction throws', async () => {
    let failPreviewConstruction = false
    const { service } = makeService({
      randomBytes: size => {
        if (failPreviewConstruction) throw new Error('preview construction failed')
        return Buffer.alloc(size, 1)
      }
    })
    const preview = await service.scan()
    failPreviewConstruction = true
    await expect(service.scan()).rejects.toThrow('preview construction failed')
    await expect(service.consumePreparedPlanForApply(preview.scanId)).resolves.toBeUndefined()
  })

  it('reports target-empty settings and does not leak config secrets through errors', async () => {
    const secret = 'inbound-secret'
    const { service, entries } = makeService({ entries: { [CONFIG_PATH]: { bytes: Buffer.from(JSON.stringify({ apiKey: secret, adminApiKey: 'admin' })) } } })
    const preview = await service.scan()
    expect(preview.settings).toMatchObject({ apiKey: { state: 'target_empty' }, adminApiKey: { state: 'target_empty' } })

    entries[CONFIG_PATH].bytes = Buffer.from(JSON.stringify({ apiKey: `${secret}\u0001` }))
    try {
      await service.scan()
      throw new Error('expected invalid config to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID })
      expect(String(error)).not.toContain(secret)
    }
    await expect(service.consumePreparedPlanForApply(preview.scanId)).resolves.toBeUndefined()
  })
})
