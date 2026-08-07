import {
  KSK_AUTOMATION_STATE,
  KSK_PROVIDER_POLL_INTERVAL_SECONDS,
  parseKskProviderResponse,
  type KskAutomationStatus,
  type KskAutomationStatusEvent,
  type ProviderKskCredential
} from '../../shared/kskAutomation'
import type { PersistedKskAutomationStore, PersistedKskAutomationTask } from './configStore'
import { sendKskAddedEmail, type KskEmailCredential } from './emailNotifier'
import {
  cleanupInvalidLocalAdminCredentials,
  syncKskAccountsToLocalAdmin,
  type KskAutomationFetch,
  type LocalAdminAccount
} from './localAdminClient'
import {
  KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
  mapWithConcurrency,
  type KskCredentialCleanupResult
} from './credentialCleanup'

export interface ImportedKskCredential extends ProviderKskCredential {
  added: boolean
}

export interface KskAutomationManagerDeps {
  readStore: () => Promise<PersistedKskAutomationStore>
  readTask: (taskId: string) => Promise<PersistedKskAutomationTask | undefined>
  fetchImpl: KskAutomationFetch
  localAdminFetchImpl?: KskAutomationFetch
  importCredential: (
    input: ProviderKskCredential & { groupId?: string }
  ) => Promise<ImportedKskCredential>
  readLocalAdminAccounts: (groupId: string) => Promise<LocalAdminAccount[]>
  cleanupProxyAccounts?: (groupId?: string) => Promise<KskCredentialCleanupResult>
  notifyStatus: (event: KskAutomationStatusEvent) => void
  notifyAccountsChanged: () => void
  sendAddedEmail?: typeof sendKskAddedEmail
  log?: (message: string) => void
}

const EMPTY_STATUS: KskAutomationStatus = {
  state: KSK_AUTOMATION_STATE.IDLE,
  running: false,
  consecutiveFailures: 0,
  lastFetchedCount: 0,
  lastAddedCount: 0,
  totalAddedCount: 0,
  lastEmailedCount: 0,
  lastLocalAdminSyncedCount: 0,
  lastLocalAdminVerifiedCount: 0,
  lastCleanupCheckedCount: 0,
  lastCleanupRemovedCount: 0,
  lastCleanupRetainedCount: 0
}

interface KskAutomationRunnerDeps extends Omit<
  KskAutomationManagerDeps,
  'readStore' | 'readTask' | 'notifyStatus'
> {
  taskId: string
  readTask: () => Promise<PersistedKskAutomationTask | undefined>
  notifyStatus: (status: KskAutomationStatus) => void
}

class KskAutomationRunner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private roundPromise: Promise<void> | null = null
  private localAdminRunning = false
  private localAdminQueued = false
  private localAdminPromise: Promise<void> | null = null
  private lastLocalAdminIssues: string[] = []
  private readonly pendingEmail = new Map<string, KskEmailCredential>()
  private status: KskAutomationStatus

  constructor(
    private readonly deps: KskAutomationRunnerDeps,
    initialStatus: KskAutomationStatus = EMPTY_STATUS
  ) {
    this.status = { ...initialStatus, running: false, nextRunAt: undefined }
  }

  snapshot(): KskAutomationStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    this.stop()
    const task = await this.deps.readTask()
    if (!task || !task.enabled) {
      this.status = { ...this.status, state: KSK_AUTOMATION_STATE.IDLE, running: false }
      this.pushStatus()
      return
    }
    this.stopped = false
    if (task.config.providerEnabled && task.secrets.providerUrl) this.scheduleNext(0)
    else this.pushStatus()
    if (task.config.localAdminEnabled) this.queueLocalAdminSync()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.localAdminQueued = false
    this.status = { ...this.status, running: false, nextRunAt: undefined }
  }

  async runNow(): Promise<KskAutomationStatus> {
    const task = await this.deps.readTask()
    if (!task?.enabled) throw new Error('任务已暂停，请先恢复任务')
    if (!task.config.providerEnabled || !task.secrets.providerUrl) {
      throw new Error('任务未开启 KSK Provider 拉取或未配置 URL')
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stopped = false
    await this.runRound()
    return this.snapshot()
  }

  queueLocalAdminSync(): void {
    if (this.stopped) return
    this.localAdminQueued = true
    if (this.localAdminPromise) return
    this.localAdminPromise = this.drainLocalAdminQueue().finally(() => {
      this.localAdminPromise = null
      if (this.localAdminQueued) this.queueLocalAdminSync()
    })
  }

  async syncLocalAdminNow(): Promise<KskAutomationStatus> {
    const task = await this.deps.readTask()
    if (!task?.enabled) throw new Error('任务已暂停，请先恢复任务')
    if (!task.config.localAdminEnabled) throw new Error('任务未开启本机 Admin 同步')
    this.stopped = false
    this.queueLocalAdminSync()
    while (this.localAdminPromise) await this.localAdminPromise
    return this.snapshot()
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.status = { ...this.status, nextRunAt: Date.now() + delayMs }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runRound()
    }, delayMs)
    this.pushStatus()
  }

  private runRound(): Promise<void> {
    if (this.roundPromise) return this.roundPromise
    this.roundPromise = this.executeRound().finally(() => {
      this.roundPromise = null
    })
    return this.roundPromise
  }

  private async executeRound(): Promise<void> {
    this.status = {
      ...this.status,
      state: KSK_AUTOMATION_STATE.RUNNING,
      running: true,
      lastAttemptAt: Date.now(),
      nextRunAt: undefined,
      lastAddedCount: 0,
      lastEmailedCount: 0,
      lastCleanupCheckedCount: 0,
      lastCleanupRemovedCount: 0,
      lastCleanupRetainedCount: 0
    }
    this.pushStatus()

    try {
      const task = await this.deps.readTask()
      if (!task?.enabled || !task.config.providerEnabled || !task.secrets.providerUrl) {
        this.stopped = true
        this.status = { ...this.status, state: KSK_AUTOMATION_STATE.IDLE, running: false }
        return
      }
      const providerUrl = new URL(task.secrets.providerUrl)
      if (providerUrl.protocol !== 'https:') throw new Error('KSK 提供接口必须使用 HTTPS')

      const payload = await this.fetchProvider(
        providerUrl.toString(),
        task.config.requestTimeoutSeconds
      )
      const parsed = parseKskProviderResponse(payload)
      let importFailureCount = 0
      const importResults = await mapWithConcurrency(
        parsed.credentials,
        KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
        async (credential, index): Promise<ImportedKskCredential | null> => {
          try {
            return await this.deps.importCredential({
              ...credential,
              groupId: task.config.providerGroupId
            })
          } catch {
            importFailureCount++
            this.log(`第 ${index + 1} 条 Provider KSK 验活或入库失败`)
            return null
          }
        }
      )
      const added = importResults.filter((credential): credential is ImportedKskCredential =>
        Boolean(credential?.added)
      )
      const roundIssues: string[] = []
      if (added.length > 0) {
        if (task.config.localAdminEnabled) {
          this.queueLocalAdminSync()
          while (this.localAdminPromise) await this.localAdminPromise
          roundIssues.push(...this.lastLocalAdminIssues)
        }
        if (task.config.cleanupInvalidOnAdd) {
          const cleanupResults: KskCredentialCleanupResult[] = []
          if (this.deps.cleanupProxyAccounts) {
            try {
              cleanupResults.push(await this.deps.cleanupProxyAccounts(task.config.providerGroupId))
            } catch (error) {
              roundIssues.push(
                `Proxy RS 清理失败：${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          if (task.config.localAdminEnabled) {
            try {
              cleanupResults.push(
                await cleanupInvalidLocalAdminCredentials({
                  baseUrl: task.config.localAdminBaseUrl,
                  adminApiKey: task.secrets.localAdminApiKey,
                  timeoutSeconds: task.config.requestTimeoutSeconds,
                  fetchImpl: this.deps.localAdminFetchImpl ?? this.deps.fetchImpl
                })
              )
            } catch (error) {
              roundIssues.push(
                `本机 Admin 清理失败：${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          const cleanup = cleanupResults.reduce<KskCredentialCleanupResult>(
            (total, current) => ({
              checked: total.checked + current.checked,
              removed: total.removed + current.removed,
              retainedTransient: total.retainedTransient + current.retainedTransient,
              errors: [...total.errors, ...current.errors]
            }),
            { checked: 0, removed: 0, retainedTransient: 0, errors: [] }
          )
          this.status = {
            ...this.status,
            lastCleanupCheckedCount: cleanup.checked,
            lastCleanupRemovedCount: cleanup.removed,
            lastCleanupRetainedCount: cleanup.retainedTransient
          }
          roundIssues.push(...cleanup.errors)
          if (cleanup.retainedTransient > 0) {
            roundIssues.push(`保留 ${cleanup.retainedTransient} 个暂时无法确认的账号`)
          }
        }
        this.deps.notifyAccountsChanged()
      }

      this.status = {
        ...this.status,
        lastFetchedCount: parsed.credentials.length,
        lastAddedCount: added.length,
        totalAddedCount: this.status.totalAddedCount + added.length
      }

      let emailedCount = 0
      if (task.config.emailEnabled) {
        for (const credential of added) {
          this.pendingEmail.set(credential.key, {
            key: credential.key,
            region: credential.region
          })
        }
        const pending = [...this.pendingEmail.values()]
        emailedCount = await (this.deps.sendAddedEmail ?? sendKskAddedEmail)(
          {
            host: task.config.smtpHost,
            port: task.config.smtpPort,
            secure: task.config.smtpSecure,
            username: task.config.smtpUsername,
            password: task.secrets.smtpPassword,
            from: task.config.smtpFrom,
            to: task.config.smtpTo
          },
          pending
        )
        this.pendingEmail.clear()
      } else {
        this.pendingEmail.clear()
      }

      roundIssues.push(
        parsed.rejectedCount > 0 ? `忽略 ${parsed.rejectedCount} 条无效或重复记录` : '',
        importFailureCount > 0 ? `${importFailureCount} 条 KSK 验活或入库失败` : ''
      )
      const effectiveRoundIssues = roundIssues.filter(Boolean)

      this.status = {
        ...this.status,
        state:
          effectiveRoundIssues.length > 0
            ? KSK_AUTOMATION_STATE.DEGRADED
            : KSK_AUTOMATION_STATE.HEALTHY,
        running: false,
        lastSuccessAt: Date.now(),
        lastError: effectiveRoundIssues.length > 0 ? effectiveRoundIssues.join('；') : undefined,
        consecutiveFailures: 0,
        lastEmailedCount: emailedCount
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.status = {
        ...this.status,
        state: KSK_AUTOMATION_STATE.DEGRADED,
        running: false,
        lastError: message,
        consecutiveFailures: this.status.consecutiveFailures + 1
      }
      this.log(`轮询失败：${message}`)
    } finally {
      this.pushStatus()
      if (!this.stopped) this.scheduleNext(KSK_PROVIDER_POLL_INTERVAL_SECONDS * 1000)
    }
  }

  private async fetchProvider(url: string, timeoutSeconds: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(3, timeoutSeconds) * 1000)
    try {
      const response = await this.deps.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`KSK 提供接口请求失败: HTTP ${response.status}`)
      return (await response.json()) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  private async drainLocalAdminQueue(): Promise<void> {
    if (this.localAdminRunning) return
    this.localAdminRunning = true
    try {
      while (this.localAdminQueued) {
        this.localAdminQueued = false
        await this.syncLocalAdmin()
      }
    } finally {
      this.localAdminRunning = false
    }
  }

  private async syncLocalAdmin(): Promise<void> {
    try {
      const task = await this.deps.readTask()
      const groupId = task?.config.localAdminGroupId
      if (!task?.enabled || !task.config.localAdminEnabled || !groupId) {
        this.lastLocalAdminIssues = []
        return
      }
      const accounts = await this.deps.readLocalAdminAccounts(groupId)
      const result = await syncKskAccountsToLocalAdmin({
        accounts,
        baseUrl: task.config.localAdminBaseUrl,
        adminApiKey: task.secrets.localAdminApiKey,
        timeoutSeconds: task.config.requestTimeoutSeconds,
        fetchImpl: this.deps.localAdminFetchImpl ?? this.deps.fetchImpl
      })
      this.status = {
        ...this.status,
        lastLocalAdminSyncedCount: result.synced,
        lastLocalAdminVerifiedCount: result.verified,
        lastError: result.errors.length > 0 ? result.errors.join('；') : this.status.lastError,
        state: result.errors.length > 0 ? KSK_AUTOMATION_STATE.DEGRADED : this.status.state
      }
      this.lastLocalAdminIssues = result.errors
      this.pushStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.status = {
        ...this.status,
        state: KSK_AUTOMATION_STATE.DEGRADED,
        lastError: message
      }
      this.lastLocalAdminIssues = [message]
      this.log(`本机 Admin 同步失败：${message}`)
      this.pushStatus()
    }
  }

  private pushStatus(): void {
    this.deps.notifyStatus(this.snapshot())
  }

  private log(message: string): void {
    ;(this.deps.log ?? ((text) => console.log(text)))(
      `[KskAutomation:${this.deps.taskId}] ${message}`
    )
  }
}

export class KskAutomationManager {
  private readonly runners = new Map<string, KskAutomationRunner>()

  constructor(private readonly deps: KskAutomationManagerDeps) {}

  async start(): Promise<void> {
    const store = await this.deps.readStore()
    for (const task of store.tasks) await this.reloadTask(task.id)
  }

  stop(): void {
    for (const runner of this.runners.values()) runner.stop()
    this.runners.clear()
  }

  snapshot(taskId: string): KskAutomationStatus {
    return this.runners.get(taskId)?.snapshot() ?? { ...EMPTY_STATUS }
  }

  async reloadTask(taskId: string): Promise<void> {
    const previous = this.runners.get(taskId)
    const previousStatus = previous?.snapshot()
    previous?.stop()
    this.runners.delete(taskId)
    const task = await this.deps.readTask(taskId)
    if (!task) return
    const runner = new KskAutomationRunner(
      {
        taskId,
        readTask: () => this.deps.readTask(taskId),
        fetchImpl: this.deps.fetchImpl,
        localAdminFetchImpl: this.deps.localAdminFetchImpl,
        importCredential: this.deps.importCredential,
        readLocalAdminAccounts: this.deps.readLocalAdminAccounts,
        cleanupProxyAccounts: this.deps.cleanupProxyAccounts,
        notifyAccountsChanged: this.deps.notifyAccountsChanged,
        notifyStatus: (status) => this.deps.notifyStatus({ taskId, status }),
        sendAddedEmail: this.deps.sendAddedEmail,
        log: this.deps.log
      },
      previousStatus
    )
    this.runners.set(taskId, runner)
    await runner.start()
  }

  removeTask(taskId: string): void {
    this.runners.get(taskId)?.stop()
    this.runners.delete(taskId)
  }

  async runNow(taskId: string): Promise<KskAutomationStatus> {
    if (!this.runners.has(taskId)) await this.reloadTask(taskId)
    const runner = this.runners.get(taskId)
    if (!runner) throw new Error('任务不存在或已删除')
    return runner.runNow()
  }

  async syncLocalAdminNow(taskId: string): Promise<KskAutomationStatus> {
    if (!this.runners.has(taskId)) await this.reloadTask(taskId)
    const runner = this.runners.get(taskId)
    if (!runner) throw new Error('任务不存在或已删除')
    return runner.syncLocalAdminNow()
  }

  queueLocalAdminSync(): void {
    for (const runner of this.runners.values()) runner.queueLocalAdminSync()
  }
}
