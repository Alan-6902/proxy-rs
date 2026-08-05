import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  LEGACY_KIRO_RS_MIGRATION_ERROR_CODES,
  LegacyKiroRsMigrationError,
  type LegacyKiroRsMigrationAccountPreview,
  type LegacyKiroRsMigrationPreview,
  type LegacyKiroRsMigrationSettingState
} from '../shared/legacyKiroRsMigration'

const CONFIG_FILE_NAME = 'config.json'
const CREDENTIALS_FILE_NAME = 'credentials.json'
const CONFIG_MAX_BYTES = 256 * 1024
const CREDENTIALS_MAX_BYTES = 8 * 1024 * 1024
const MAX_CREDENTIALS = 1000
const MAX_JSON_DEPTH = 8
const MAX_KEY_BYTES = 4096
const SCAN_TTL_MS = 10 * 60 * 1000
const UNSUPPORTED_CONFIG_KEYS = new Set([
  'proxyUrl',
  'host',
  'port',
  'endpoints',
  'machine',
  'tls',
  'countTokens'
])

type MigrationStat = {
  uid: number
  mode: number
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

type TargetKeyIndex = {
  snapshot: LegacyKiroRsMigrationTargetSnapshot
  keyHashes: string[]
  buckets: Map<string, string[]>
  fingerprint: string
}

type PreparedPlanTimer = { unref?: () => void }
type MigrationFileHandle = {
  stat(): Promise<MigrationStat>
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface LegacyKiroRsMigrationFileSystem {
  lstat(filePath: string): Promise<MigrationStat>
  realpath(filePath: string): Promise<string>
  open(filePath: string, flags: number): Promise<MigrationFileHandle>
}

export interface LegacyKiroRsMigrationTargetSnapshot {
  upstreamKiroApiKeys: Iterable<string>
  apiKeys: Iterable<{ key: string; enabled: boolean }>
  apiKey?: string
  adminApiKey?: string
}

export interface LegacyKiroRsMigrationDependencies {
  fileSystem?: LegacyKiroRsMigrationFileSystem
  readTargetSnapshot: () => Promise<LegacyKiroRsMigrationTargetSnapshot>
  now?: () => number
  randomBytes?: (size: number) => Buffer
  homeDirectory?: string
  currentUid?: number
  isPosixPlatform?: () => boolean
  scheduleExpiration?: (callback: () => void, delayMs: number) => { unref?: () => void }
  clearExpiration?: (timer: { unref?: () => void }) => void
}

export interface PreparedCredential {
  itemId: string
  kiroApiKey: string
  keyHash: string
  state: 'new' | 'existing' | 'duplicate'
}

export interface PreparedMigrationPlan {
  scanId: string
  expiresAt: number
  sourceFingerprint: string
  targetFingerprint: string
  credentials: PreparedCredential[]
  apiKey?: string
  adminApiKey?: string
}

interface ValidatedSource {
  config: Record<string, unknown>
  credentials: Array<Record<string, unknown>>
  sourceFingerprint: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}

function hasAllowedJsonDepth(value: unknown, depth = 1): boolean {
  if (depth > MAX_JSON_DEPTH) return false
  if (Array.isArray(value)) return value.every(item => hasAllowedJsonDepth(item, depth + 1))
  if (isPlainObject(value)) return Object.values(value).every(item => hasAllowedJsonDepth(item, depth + 1))
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function isValidKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_KEY_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isSafeRegularFile(stat: MigrationStat, currentUid: number): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === currentUid
    && (stat.mode & 0o022) === 0
}

function sameStat(first: MigrationStat, second: MigrationStat): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs
}

function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest()
}

function sameSecret(first: string, second: string): boolean {
  return timingSafeEqual(digest(first), digest(second))
}

function stableTargetFingerprint(
  upstreamKeyHashes: string[],
  apiKeys: Array<{ keyHash: string; enabled: boolean }>,
  snapshot: LegacyKiroRsMigrationTargetSnapshot
): string {
  return digest(JSON.stringify({
    upstream: [...upstreamKeyHashes].sort(),
    apiKeys: apiKeys
      .map(({ keyHash, enabled }) => ({ keyHash, enabled }))
      .sort((left, right) => left.keyHash.localeCompare(right.keyHash) || Number(left.enabled) - Number(right.enabled)),
    apiKey: snapshot.apiKey === undefined ? undefined : digest(snapshot.apiKey).toString('hex'),
    adminApiKey: snapshot.adminApiKey === undefined ? undefined : digest(snapshot.adminApiKey).toString('hex')
  })).toString('hex')
}

export class LegacyKiroRsMigrationService {
  private readonly fileSystem: LegacyKiroRsMigrationFileSystem
  private readonly now: () => number
  private readonly randomBytes: (size: number) => Buffer
  private readonly sourceDirectory: string
  private readonly currentUid: number | undefined
  private readonly isPosixPlatform: () => boolean
  private readonly scheduleExpiration: (callback: () => void, delayMs: number) => PreparedPlanTimer
  private readonly clearExpiration: (timer: PreparedPlanTimer) => void
  private preparedPlan: PreparedMigrationPlan | undefined
  private preparedPlanTimer: PreparedPlanTimer | undefined

  constructor(private readonly dependencies: LegacyKiroRsMigrationDependencies) {
    this.fileSystem = dependencies.fileSystem ?? fs
    this.now = dependencies.now ?? Date.now
    this.randomBytes = dependencies.randomBytes ?? randomBytes
    this.sourceDirectory = path.join(dependencies.homeDirectory ?? os.homedir(), 'kiro-rs', 'config')
    this.isPosixPlatform = dependencies.isPosixPlatform ?? (() => process.platform !== 'win32' && typeof process.getuid === 'function')
    this.currentUid = dependencies.currentUid ?? (this.isPosixPlatform() ? process.getuid?.() : undefined)
    this.scheduleExpiration = dependencies.scheduleExpiration ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearExpiration = dependencies.clearExpiration ?? (timer => clearTimeout(timer as NodeJS.Timeout))
  }

  async scan(): Promise<LegacyKiroRsMigrationPreview> {
    this.assertSupportedPlatform()
    this.discardPreparedPlan()
    const source = await this.readValidatedSource()
    const target = await this.readTargetIndex()
    const scanId = this.randomBytes(16).toString('hex')
    const hmacKey = this.randomBytes(32)
    const preparedCredentials: PreparedCredential[] = []
    const seenSourceKeys = new Map<string, string[]>()
    const items: LegacyKiroRsMigrationAccountPreview[] = []
    let newCount = 0
    let existingCount = 0
    let duplicateCount = 0

    for (const credential of source.credentials) {
      const key = credential.kiroApiKey
      if (!isValidKey(key)) throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_CREDENTIAL_INVALID)

      const keyHash = digest(key).toString('hex')
      const isDuplicate = this.isSecretInBucket(seenSourceKeys.get(keyHash), key)
      const existsInTarget = this.isSecretInBucket(target.buckets.get(keyHash), key)
      const state = isDuplicate ? 'duplicate' : existsInTarget ? 'existing' : 'new'

      if (state === 'new') newCount += 1
      if (state === 'existing') existingCount += 1
      if (state === 'duplicate') duplicateCount += 1
      this.addSecretToBucket(seenSourceKeys, keyHash, key)
      const itemId = `item_${scanId}_${preparedCredentials.length}`
      const redactedId = createHmac('sha256', hmacKey).update(key).digest('hex').slice(0, 16)
      preparedCredentials.push({ itemId, kiroApiKey: key, keyHash, state })
      items.push({ itemId, redactedId, state })
    }

    const apiKey = this.readConfigKey(source.config, 'apiKey')
    const adminApiKey = this.readConfigKey(source.config, 'adminApiKey')
    const expiresAt = this.now() + SCAN_TTL_MS
    const preview: LegacyKiroRsMigrationPreview = {
      scanId,
      expiresAt,
      accounts: {
        available: items.length,
        new: newCount,
        existing: existingCount,
        duplicate: duplicateCount,
        items
      },
      settings: {
        apiKey: { state: this.getSettingState(apiKey, target.snapshot.apiKey) },
        adminApiKey: { state: this.getSettingState(adminApiKey, target.snapshot.adminApiKey) },
        unsupportedCount: Object.keys(source.config).filter(key => UNSUPPORTED_CONFIG_KEYS.has(key)).length
      }
    }
    this.storePreparedPlan({
      scanId,
      expiresAt,
      sourceFingerprint: source.sourceFingerprint,
      targetFingerprint: target.fingerprint,
      credentials: preparedCredentials,
      apiKey,
      adminApiKey
    })
    return preview
  }

  async consumePreparedPlanForApply(scanId: string): Promise<PreparedMigrationPlan | undefined> {
    this.assertSupportedPlatform()
    this.removeExpiredPlan()
    if (!this.preparedPlan || this.preparedPlan.scanId !== scanId) return undefined

    const plan = this.preparedPlan
    this.discardPreparedPlan()
    const source = await this.readValidatedSource()
    const target = await this.readTargetIndex()
    if (source.sourceFingerprint !== plan.sourceFingerprint || target.fingerprint !== plan.targetFingerprint) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.STALE_SCAN)
    }
    return plan
  }

  private assertSupportedPlatform(): void {
    if (!this.isPosixPlatform() || this.currentUid === undefined || typeof constants.O_NOFOLLOW !== 'number') {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.UNSUPPORTED_PLATFORM)
    }
  }

  private async readValidatedSource(): Promise<ValidatedSource> {
    await this.assertSafeDirectory()
    const config = await this.readJsonFile(CONFIG_FILE_NAME, CONFIG_MAX_BYTES)
    const credentials = await this.readJsonFile(CREDENTIALS_FILE_NAME, CREDENTIALS_MAX_BYTES)

    if (!isPlainObject(config.value)) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID)
    }
    if (!Array.isArray(credentials.value) || credentials.value.length > MAX_CREDENTIALS || !credentials.value.every(isPlainObject)) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID)
    }

    return {
      config: config.value,
      credentials: credentials.value,
      sourceFingerprint: digest(Buffer.concat([config.bytes, credentials.bytes])).toString('hex')
    }
  }

  private async assertSafeDirectory(): Promise<void> {
    let stat: MigrationStat
    try {
      stat = await this.fileSystem.lstat(this.sourceDirectory)
      const realPath = await this.fileSystem.realpath(this.sourceDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.currentUid || (stat.mode & 0o022) !== 0 || realPath !== this.sourceDirectory) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_DIRECTORY_UNSAFE)
      }
    } catch (error) {
      if (error instanceof LegacyKiroRsMigrationError) throw error
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_DIRECTORY_UNSAFE)
    }
  }

  private async readJsonFile(fileName: string, maxBytes: number): Promise<{ value: unknown; bytes: Buffer }> {
    const filePath = path.join(this.sourceDirectory, fileName)
    let pathStat: MigrationStat
    let handle: MigrationFileHandle | undefined
    try {
      pathStat = await this.fileSystem.lstat(filePath)
      const realPath = await this.fileSystem.realpath(filePath)
      if (!isSafeRegularFile(pathStat, this.currentUid!) || realPath !== filePath) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_UNSAFE)
      }
      if (pathStat.size > maxBytes) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_TOO_LARGE)
      }

      handle = await this.fileSystem.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat()
      if (!isSafeRegularFile(before, this.currentUid!) || !sameStat(pathStat, before) || before.size > maxBytes) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_CHANGED)
      }
      const bytes = await this.readBoundedFile(handle, maxBytes)
      const after = await handle.stat()
      if (!isSafeRegularFile(after, this.currentUid!) || !sameStat(before, after) || bytes.length !== before.size) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_CHANGED)
      }

      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_JSON_INVALID)
      }
      if (!hasAllowedJsonDepth(value)) {
        throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID)
      }
      return { value, bytes }
    } catch (error) {
      if (error instanceof LegacyKiroRsMigrationError) throw error
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_MISSING)
    } finally {
      await handle?.close()
    }
  }

  private async readBoundedFile(handle: MigrationFileHandle, maxBytes: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_FILE_TOO_LARGE)
    }
    return buffer.subarray(0, offset)
  }

  private async readTargetIndex(): Promise<TargetKeyIndex> {
    const snapshot = await this.dependencies.readTargetSnapshot()
    if (!snapshot || typeof snapshot !== 'object') {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
    }

    const upstreamKiroApiKeys: string[] = []
    const apiKeys: Array<{ key: string; enabled: boolean }> = []
    try {
      for (const key of snapshot.upstreamKiroApiKeys) {
        if (upstreamKiroApiKeys.length >= MAX_CREDENTIALS || !isValidKey(key)) {
          throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
        }
        upstreamKiroApiKeys.push(key)
      }
      for (const apiKey of snapshot.apiKeys) {
        if (apiKeys.length >= MAX_CREDENTIALS || !apiKey || !isValidKey(apiKey.key) || typeof apiKey.enabled !== 'boolean') {
          throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
        }
        apiKeys.push({ key: apiKey.key, enabled: apiKey.enabled })
      }
    } catch (error) {
      if (error instanceof LegacyKiroRsMigrationError) throw error
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
    }
    if ((snapshot.apiKey !== undefined && !isValidKey(snapshot.apiKey))
      || (snapshot.adminApiKey !== undefined && !isValidKey(snapshot.adminApiKey))) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.TARGET_SNAPSHOT_INVALID)
    }

    const buckets = new Map<string, string[]>()
    const keyHashes: string[] = []
    for (const key of upstreamKiroApiKeys) {
      const keyHash = digest(key).toString('hex')
      keyHashes.push(keyHash)
      this.addSecretToBucket(buckets, keyHash, key)
    }
    const apiKeyHashes = apiKeys.map(apiKey => ({ keyHash: digest(apiKey.key).toString('hex'), enabled: apiKey.enabled }))
    return {
      snapshot: { ...snapshot, upstreamKiroApiKeys, apiKeys },
      keyHashes,
      buckets,
      fingerprint: stableTargetFingerprint(keyHashes, apiKeyHashes, snapshot)
    }
  }

  private addSecretToBucket(buckets: Map<string, string[]>, keyHash: string, key: string): void {
    const bucket = buckets.get(keyHash)
    if (bucket) {
      bucket.push(key)
    } else {
      buckets.set(keyHash, [key])
    }
  }

  private isSecretInBucket(bucket: string[] | undefined, key: string): boolean {
    return bucket !== undefined && bucket.some(candidate => sameSecret(candidate, key))
  }

  private readConfigKey(config: Record<string, unknown>, key: 'apiKey' | 'adminApiKey'): string | undefined {
    const value = config[key]
    if (value === undefined) return undefined
    if (!isValidKey(value)) {
      throw new LegacyKiroRsMigrationError(LEGACY_KIRO_RS_MIGRATION_ERROR_CODES.SOURCE_SCHEMA_INVALID)
    }
    return value
  }

  private getSettingState(sourceValue: string | undefined, targetValue: string | undefined): LegacyKiroRsMigrationSettingState {
    if (!sourceValue) return 'absent'
    if (!targetValue) return 'target_empty'
    return sameSecret(sourceValue, targetValue) ? 'matches' : 'conflict'
  }

  private storePreparedPlan(plan: PreparedMigrationPlan): void {
    this.discardPreparedPlan()
    this.preparedPlan = plan
    const timer = this.scheduleExpiration(() => {
      if (this.preparedPlan?.scanId === plan.scanId) this.discardPreparedPlan(false)
    }, SCAN_TTL_MS)
    timer.unref?.()
    this.preparedPlanTimer = timer
  }

  private discardPreparedPlan(clearTimer = true): void {
    if (clearTimer && this.preparedPlanTimer) this.clearExpiration(this.preparedPlanTimer)
    this.preparedPlan = undefined
    this.preparedPlanTimer = undefined
  }

  private removeExpiredPlan(): void {
    if (this.preparedPlan && this.preparedPlan.expiresAt <= this.now()) this.discardPreparedPlan()
  }
}
