import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KSK_AUTOMATION_CONFIG,
  KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS,
  KSK_AUTOMATION_STATE,
  KSK_AUTOMATION_STORE_VERSION,
  KSK_AUTOMATION_TASK_TYPE,
  KSK_PROVIDER_POLL_INTERVAL_SECONDS,
  maskSecretTail,
  providerUrlHint,
  type KskAutomationConfig,
  type KskAutomationConfigView,
  type KskAutomationSecretInput,
  type KskAutomationStatus,
  type KskAutomationTaskInput,
  type KskAutomationTaskView
} from '../../shared/kskAutomation'

const STORE_FILE = 'ksk-automation.enc'
const LEGACY_TASK_ID = 'legacy-ksk-automation'
const LEGACY_TASK_NAME = '自动拉取 KSK'

export interface KskAutomationSecrets {
  providerUrl: string
  smtpPassword: string
  localAdminApiKey: string
}

export interface PersistedKskAutomationTask {
  id: string
  name: string
  type: typeof KSK_AUTOMATION_TASK_TYPE
  enabled: boolean
  createdAt: number
  updatedAt: number
  config: KskAutomationConfig
  secrets: KskAutomationSecrets
}

export interface PersistedKskAutomationStore {
  version: typeof KSK_AUTOMATION_STORE_VERSION
  tasks: PersistedKskAutomationTask[]
}

interface LegacyKskAutomationState {
  config?: Partial<KskAutomationConfig>
  secrets?: Partial<KskAutomationSecrets>
}

const EMPTY_STATUS: KskAutomationStatus = {
  state: KSK_AUTOMATION_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  lastFetchedCount: 0,
  lastAddedCount: 0,
  totalAddedCount: 0,
  lastRejectedCount: 0,
  lastEmailedCount: 0,
  lastLocalAdminSyncedCount: 0,
  lastLocalAdminVerifiedCount: 0,
  lastLocalAdminPrunedCount: 0,
  lastCleanupCheckedCount: 0,
  lastCleanupRemovedCount: 0,
  lastCleanupRetainedCount: 0,
  logs: []
}

let mutationQueue: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numberValue)))
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeSecrets(
  input: Partial<KskAutomationSecrets> | null | undefined
): KskAutomationSecrets {
  return {
    providerUrl: normalizeString(input?.providerUrl),
    smtpPassword: normalizeString(input?.smtpPassword),
    localAdminApiKey: normalizeString(input?.localAdminApiKey)
  }
}

export function normalizeKskAutomationConfig(
  input: Partial<KskAutomationConfig> | null | undefined
): KskAutomationConfig {
  const source = input ?? {}
  return {
    providerEnabled: source.providerEnabled === true,
    providerGroupId: normalizeOptionalId(source.providerGroupId),
    requestTimeoutSeconds: positiveInt(
      source.requestTimeoutSeconds,
      KSK_AUTOMATION_REQUEST_TIMEOUT_SECONDS,
      3,
      120
    ),
    cleanupInvalidOnAdd: source.cleanupInvalidOnAdd !== false,
    livenessModel: normalizeString(source.livenessModel),
    livenessMessage: normalizeString(source.livenessMessage),
    emailEnabled: source.emailEnabled === true,
    smtpHost: normalizeString(source.smtpHost),
    smtpPort: positiveInt(source.smtpPort, DEFAULT_KSK_AUTOMATION_CONFIG.smtpPort, 1, 65535),
    smtpSecure: source.smtpSecure !== false,
    smtpUsername: normalizeString(source.smtpUsername),
    smtpFrom: normalizeString(source.smtpFrom),
    smtpTo: normalizeString(source.smtpTo),
    localAdminEnabled: source.localAdminEnabled === true,
    localAdminGroupId: normalizeOptionalId(source.localAdminGroupId),
    localAdminBaseUrl:
      normalizeString(source.localAdminBaseUrl) || DEFAULT_KSK_AUTOMATION_CONFIG.localAdminBaseUrl
  }
}

function emptyStore(): PersistedKskAutomationStore {
  return { version: KSK_AUTOMATION_STORE_VERSION, tasks: [] }
}

function normalizeTask(value: unknown, now: number): PersistedKskAutomationTask | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PersistedKskAutomationTask>
  const id = normalizeString(source.id)
  if (!id) return null
  const createdAt = positiveInt(source.createdAt, now, 0, Number.MAX_SAFE_INTEGER)
  return {
    id,
    name: normalizeString(source.name) || LEGACY_TASK_NAME,
    type: KSK_AUTOMATION_TASK_TYPE,
    enabled: source.enabled !== false,
    createdAt,
    updatedAt: positiveInt(source.updatedAt, createdAt, 0, Number.MAX_SAFE_INTEGER),
    config: normalizeKskAutomationConfig(source.config),
    secrets: normalizeSecrets(source.secrets)
  }
}

/** 把 v1 单例配置无损映射成一条任务；纯函数便于迁移测试。 */
export function normalizeKskAutomationStorePayload(
  payload: unknown,
  now = Date.now()
): PersistedKskAutomationStore {
  if (!payload || typeof payload !== 'object') return emptyStore()
  const source = payload as Partial<PersistedKskAutomationStore> & LegacyKskAutomationState
  if (source.version === KSK_AUTOMATION_STORE_VERSION && Array.isArray(source.tasks)) {
    const ids = new Set<string>()
    const tasks = source.tasks
      .map((task) => normalizeTask(task, now))
      .filter((task): task is PersistedKskAutomationTask => Boolean(task))
      .filter((task) => {
        if (ids.has(task.id)) return false
        ids.add(task.id)
        return true
      })
    return { version: KSK_AUTOMATION_STORE_VERSION, tasks }
  }

  const config = normalizeKskAutomationConfig(source.config)
  const secrets = normalizeSecrets(source.secrets)
  const hasLegacyTask =
    config.providerEnabled ||
    config.localAdminEnabled ||
    Boolean(secrets.providerUrl || secrets.smtpPassword || secrets.localAdminApiKey)
  if (!hasLegacyTask) return emptyStore()
  return {
    version: KSK_AUTOMATION_STORE_VERSION,
    tasks: [
      {
        id: LEGACY_TASK_ID,
        name: LEGACY_TASK_NAME,
        type: KSK_AUTOMATION_TASK_TYPE,
        enabled: config.providerEnabled || config.localAdminEnabled,
        createdAt: now,
        updatedAt: now,
        config,
        secrets
      }
    ]
  }
}

export function isKskAutomationStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export async function loadKskAutomationStore(): Promise<PersistedKskAutomationStore> {
  if (!isKskAutomationStoreAvailable()) return emptyStore()
  try {
    const encrypted = await fs.readFile(storePath())
    return normalizeKskAutomationStorePayload(JSON.parse(safeStorage.decryptString(encrypted)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw new Error('自动任务配置无法解密或已损坏，已拒绝用空配置覆盖原文件')
  }
}

export async function loadKskAutomationTask(
  taskId: string
): Promise<PersistedKskAutomationTask | undefined> {
  return (await loadKskAutomationStore()).tasks.find((task) => task.id === taskId)
}

async function saveStore(store: PersistedKskAutomationStore): Promise<void> {
  if (!isKskAutomationStoreAvailable()) {
    throw new Error('系统加密存储不可用，拒绝明文保存 Provider URL、SMTP 密码或 Admin API Key')
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(store))
  await fs.writeFile(storePath(), encrypted, { mode: 0o600 })
}

async function mutateStore<T>(
  mutate: (store: PersistedKskAutomationStore) => T | Promise<T>
): Promise<T> {
  let resolveResult: (value: T | PromiseLike<T>) => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const store = await loadKskAutomationStore()
      const value = await mutate(store)
      await saveStore(store)
      resolveResult(value)
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}

function mergeSecrets(
  current: KskAutomationSecrets,
  input: KskAutomationSecretInput | undefined
): KskAutomationSecrets {
  return {
    providerUrl:
      input?.providerUrl === undefined ? current.providerUrl : normalizeString(input.providerUrl),
    smtpPassword:
      input?.smtpPassword === undefined
        ? current.smtpPassword
        : normalizeString(input.smtpPassword),
    localAdminApiKey:
      input?.localAdminApiKey === undefined
        ? current.localAdminApiKey
        : normalizeString(input.localAdminApiKey)
  }
}

export async function createKskAutomationTask(
  id: string,
  input: KskAutomationTaskInput
): Promise<PersistedKskAutomationTask> {
  return mutateStore((store) => {
    const now = Date.now()
    const task: PersistedKskAutomationTask = {
      id,
      name: normalizeString(input.name) || LEGACY_TASK_NAME,
      type: KSK_AUTOMATION_TASK_TYPE,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      config: normalizeKskAutomationConfig(input.config),
      secrets: mergeSecrets(normalizeSecrets(undefined), input.secrets)
    }
    store.tasks.push(task)
    return task
  })
}

export async function updateKskAutomationTask(
  taskId: string,
  input: KskAutomationTaskInput
): Promise<PersistedKskAutomationTask> {
  return mutateStore((store) => {
    const task = store.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error('任务不存在或已删除')
    task.name = normalizeString(input.name) || task.name
    task.enabled = input.enabled ?? task.enabled
    task.config = normalizeKskAutomationConfig({ ...task.config, ...input.config })
    task.secrets = mergeSecrets(task.secrets, input.secrets)
    task.updatedAt = Date.now()
    return task
  })
}

export async function setKskAutomationTaskEnabled(
  taskId: string,
  enabled: boolean
): Promise<PersistedKskAutomationTask> {
  return mutateStore((store) => {
    const task = store.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error('任务不存在或已删除')
    task.enabled = enabled
    task.updatedAt = Date.now()
    return task
  })
}

export async function deleteKskAutomationTask(taskId: string): Promise<void> {
  return mutateStore((store) => {
    const index = store.tasks.findIndex((item) => item.id === taskId)
    if (index < 0) throw new Error('任务不存在或已删除')
    store.tasks.splice(index, 1)
  })
}

export function toKskAutomationConfigView(
  task: PersistedKskAutomationTask
): KskAutomationConfigView {
  return {
    ...task.config,
    pollIntervalSeconds: KSK_PROVIDER_POLL_INTERVAL_SECONDS,
    encryptionAvailable: isKskAutomationStoreAvailable(),
    hasProviderUrl: Boolean(task.secrets.providerUrl),
    providerUrlHint: providerUrlHint(task.secrets.providerUrl),
    hasSmtpPassword: Boolean(task.secrets.smtpPassword),
    hasLocalAdminApiKey: Boolean(task.secrets.localAdminApiKey),
    localAdminApiKeyTail: maskSecretTail(task.secrets.localAdminApiKey)
  }
}

export function toKskAutomationTaskView(
  task: PersistedKskAutomationTask,
  status: KskAutomationStatus = EMPTY_STATUS
): KskAutomationTaskView {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    enabled: task.enabled,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    config: toKskAutomationConfigView(task),
    status: { ...status, logs: [...(status.logs ?? [])] }
  }
}
