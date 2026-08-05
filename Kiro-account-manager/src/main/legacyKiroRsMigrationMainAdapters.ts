import { constants as fsConstants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { open, lstat, rename } from 'node:fs/promises'
import path from 'node:path'
import type { ProxyConfig } from './proxy/types'
import type {
  LegacyKiroRsMigrationJournal,
  LegacyKiroRsMigrationSnapshot
} from './legacyKiroRsMigrationTransaction'
import {
  LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES,
  LegacyKiroRsMigrationTransactionError,
  legacyKiroRsMigrationRecoveryRequiresCheckpoint
} from '../shared/legacyKiroRsMigrationTransaction'

const JOURNAL_FILE_NAME = 'legacy-kiro-rs-migration.v1.enc'
const JOURNAL_MAX_BYTES = 1024 * 1024
const FILE_MODE = 0o600

type Cloneable = unknown

export interface LegacyKiroRsMigrationSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface LegacyKiroRsMigrationFileHandle {
  chmod(mode: number): Promise<void>
  close(): Promise<void>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
  stat(): Promise<LegacyKiroRsMigrationStat>
  sync(): Promise<void>
  truncate(length?: number): Promise<void>
  write(
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesWritten: number }>
}

export interface LegacyKiroRsMigrationStat {
  dev?: number
  ino?: number
  mode: number
  size: number
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface LegacyKiroRsMigrationJournalFileSystem {
  lstat(filePath: string): Promise<LegacyKiroRsMigrationStat>
  open(
    filePath: string,
    flags: string | number,
    mode?: number
  ): Promise<LegacyKiroRsMigrationFileHandle>
  rename(from: string, to: string): Promise<void>
}

export interface LegacyKiroRsMigrationStore {
  path: string
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export class LegacyKiroRsMigrationExclusiveCoordinator {
  private tail = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export function cloneLegacyKiroRsMigrationValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function invalidJournal(): never {
  throw new LegacyKiroRsMigrationTransactionError(
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.JOURNAL_INVALID
  )
}

function encryptionUnavailable(): never {
  throw new LegacyKiroRsMigrationTransactionError(
    LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.ENCRYPTION_UNAVAILABLE
  )
}

function isSafeJournalStat(stat: LegacyKiroRsMigrationStat): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    (process.platform === 'win32' || (stat.mode & 0o777) === FILE_MODE)
  )
}

function sameJournalIdentity(
  before: LegacyKiroRsMigrationStat,
  opened: LegacyKiroRsMigrationStat
): boolean {
  return (
    (before.dev === undefined || opened.dev === undefined || before.dev === opened.dev) &&
    (before.ino === undefined || opened.ino === undefined || before.ino === opened.ino)
  )
}

function isJournalShape(value: unknown): value is LegacyKiroRsMigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const journal = value as Record<string, unknown>
  return (
    journal.version === 1 &&
    (journal.operation === 'apply' || journal.operation === 'rollback') &&
    typeof journal.state === 'string' &&
    typeof journal.scanId === 'string' &&
    !!journal.before &&
    typeof journal.before === 'object' &&
    !!journal.after &&
    typeof journal.after === 'object' &&
    typeof journal.beforeHash === 'string' &&
    typeof journal.afterHash === 'string' &&
    typeof journal.accountStepFingerprint === 'string' &&
    Array.isArray(journal.migratedAccountIds) &&
    !!journal.timestamps &&
    typeof journal.timestamps === 'object'
  )
}

export class LegacyKiroRsMigrationEncryptedJournal {
  readonly path: string

  constructor(
    storePath: string,
    private readonly safeStorage: LegacyKiroRsMigrationSafeStorage,
    private readonly fileSystem: LegacyKiroRsMigrationJournalFileSystem = { lstat, open, rename },
    private readonly platform: NodeJS.Platform = process.platform
  ) {
    this.path = path.join(path.dirname(storePath), JOURNAL_FILE_NAME)
  }

  private encryptionAvailable(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false
    if (this.platform !== 'linux') return true
    const backend = this.safeStorage.getSelectedStorageBackend?.()
    return typeof backend === 'string' && backend !== 'basic_text' && backend !== 'unknown'
  }

  async read(): Promise<LegacyKiroRsMigrationJournal | undefined> {
    if (!this.encryptionAvailable()) return encryptionUnavailable()
    let stat: LegacyKiroRsMigrationStat
    try {
      stat = await this.fileSystem.lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return invalidJournal()
    }
    if (!isSafeJournalStat(stat) || stat.size <= 0 || stat.size > JOURNAL_MAX_BYTES)
      return invalidJournal()
    let handle: LegacyKiroRsMigrationFileHandle | undefined
    try {
      const flags = this.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      handle = await this.fileSystem.open(this.path, flags)
      const openedStat = await handle.stat()
      if (
        !isSafeJournalStat(openedStat) ||
        !sameJournalIdentity(stat, openedStat) ||
        openedStat.size !== stat.size ||
        openedStat.size > JOURNAL_MAX_BYTES
      )
        return invalidJournal()
      const encrypted = Buffer.alloc(openedStat.size)
      if (!(await this.readExactly(handle, encrypted))) return invalidJournal()
      let decoded: unknown
      try {
        decoded = JSON.parse(this.safeStorage.decryptString(encrypted))
      } catch {
        return invalidJournal()
      }
      if (
        decoded &&
        typeof decoded === 'object' &&
        (decoded as Record<string, unknown>).tombstone === true &&
        (decoded as Record<string, unknown>).version === 1
      )
        return undefined
      if (!isJournalShape(decoded)) return invalidJournal()
      return cloneLegacyKiroRsMigrationValue(decoded)
    } catch (error) {
      if (error instanceof LegacyKiroRsMigrationTransactionError) throw error
      return invalidJournal()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async write(journal: LegacyKiroRsMigrationJournal): Promise<void> {
    if (!this.encryptionAvailable()) encryptionUnavailable()
    await this.writeEncrypted(cloneLegacyKiroRsMigrationValue(journal))
  }

  async remove(): Promise<void> {
    if (!this.encryptionAvailable()) encryptionUnavailable()
    await this.writeEncrypted({ version: 1, tombstone: true })
  }

  private async writeEncrypted(value: Cloneable): Promise<void> {
    let encrypted: Buffer
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(value))
    } catch {
      return encryptionUnavailable()
    }
    if (
      !Buffer.isBuffer(encrypted) ||
      encrypted.length === 0 ||
      encrypted.length > JOURNAL_MAX_BYTES
    ) {
      throw new LegacyKiroRsMigrationTransactionError(
        LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
      )
    }
    const directoryPath = path.dirname(this.path)
    const flags =
      this.platform === 'win32'
        ? 'wx'
        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const tempPath = path.join(
        directoryPath,
        `${JOURNAL_FILE_NAME}.${randomBytes(12).toString('hex')}.tmp`
      )
      let file: LegacyKiroRsMigrationFileHandle | undefined
      let renameAttempted = false
      try {
        try {
          await this.fileSystem.lstat(tempPath)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        }
        file = await this.fileSystem.open(tempPath, flags, FILE_MODE)
        await file.chmod(FILE_MODE)
        await file.truncate(0)
        let offset = 0
        while (offset < encrypted.length) {
          const { bytesWritten } = await file.write(
            encrypted,
            offset,
            encrypted.length - offset,
            offset
          )
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
            throw new LegacyKiroRsMigrationTransactionError(
              LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
            )
          }
          offset += bytesWritten
        }
        await file.sync()
        await file.close()
        file = undefined
        renameAttempted = true
        await this.fileSystem.rename(tempPath, this.path)
        const directory = await this.fileSystem.open(directoryPath, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        return
      } catch (error) {
        if (!renameAttempted && (error as NodeJS.ErrnoException).code === 'EEXIST') continue
        if (renameAttempted && (await this.matchesCommittedCipher(encrypted))) return
        if (error instanceof LegacyKiroRsMigrationTransactionError) throw error
        throw new LegacyKiroRsMigrationTransactionError(
          LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
        )
      } finally {
        await file?.close().catch(() => undefined)
      }
    }
    throw new LegacyKiroRsMigrationTransactionError(
      LEGACY_KIRO_RS_MIGRATION_TRANSACTION_ERROR_CODES.WRITE_FAILED
    )
  }

  private async readExactly(
    handle: LegacyKiroRsMigrationFileHandle,
    target: Buffer
  ): Promise<boolean> {
    let offset = 0
    while (offset < target.length) {
      const { bytesRead } = await handle.read(target, offset, target.length - offset, offset)
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) return false
      offset += bytesRead
    }
    return true
  }

  private async matchesCommittedCipher(expected: Buffer): Promise<boolean> {
    let handle: LegacyKiroRsMigrationFileHandle | undefined
    try {
      const before = await this.fileSystem.lstat(this.path)
      if (!isSafeJournalStat(before) || before.size !== expected.length) return false
      const flags = this.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      handle = await this.fileSystem.open(this.path, flags)
      const opened = await handle.stat()
      if (
        !isSafeJournalStat(opened) ||
        !sameJournalIdentity(before, opened) ||
        opened.size !== before.size
      )
        return false
      const actual = Buffer.alloc(opened.size)
      return (await this.readExactly(handle, actual)) && actual.equals(expected)
    } catch {
      return false
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

export class LegacyKiroRsMigrationElectronStoreSnapshot {
  constructor(
    private readonly store: LegacyKiroRsMigrationStore,
    private readonly syncLastSavedDataCallback: (accountData: unknown) => void
  ) {}

  async read(): Promise<LegacyKiroRsMigrationSnapshot> {
    const accountData = this.store.get('accountData')
    const proxyConfig = this.store.get('proxyConfig')
    return cloneLegacyKiroRsMigrationValue({
      accountData:
        accountData && typeof accountData === 'object'
          ? accountData
          : { accounts: {}, activeAccountId: null },
      proxyConfig: proxyConfig && typeof proxyConfig === 'object' ? proxyConfig : {}
    }) as LegacyKiroRsMigrationSnapshot
  }

  async writeAccountData(accountData: LegacyKiroRsMigrationSnapshot['accountData']): Promise<void> {
    this.store.set('accountData', cloneLegacyKiroRsMigrationValue(accountData))
  }

  async writeProxyConfig(proxyConfig: ProxyConfig): Promise<void> {
    this.store.set('proxyConfig', cloneLegacyKiroRsMigrationValue(proxyConfig))
  }

  async syncLastSavedData(): Promise<void> {
    this.syncLastSavedDataCallback(cloneLegacyKiroRsMigrationValue(this.store.get('accountData')))
  }
}

export function shouldBlockLegacyKiroRsMigrationAutoStart(status: string): boolean {
  return legacyKiroRsMigrationRecoveryRequiresCheckpoint(status)
}
