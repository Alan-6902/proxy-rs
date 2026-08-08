import {
  KSK_AUTOMATION_LOG_LEVEL,
  KSK_AUTOMATION_LOG_LIMIT,
  KSK_AUTOMATION_STATE,
  KSK_PROVIDER_POLL_INTERVAL_SECONDS,
  parseKskProviderResponse,
  type KskAutomationLogEntry,
  type KskAutomationLogLevel,
  type KskAutomationStatus,
  type KskAutomationStatusEvent,
  type KskLivenessOptions,
  type ProviderKskCredential
} from '../../shared/kskAutomation'
import type { PersistedKskAutomationStore, PersistedKskAutomationTask } from './configStore'
import { sendKskAddedEmail, type KskEmailCredential } from './emailNotifier'
import {
  deleteLocalAdminCredentialsByKey,
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
  /** 发消息验活判为永久失效，未入库。与 added=false（已存在）要分开统计。 */
  rejected?: boolean
}

export interface KskAutomationManagerDeps {
  readStore: () => Promise<PersistedKskAutomationStore>
  readTask: (taskId: string) => Promise<PersistedKskAutomationTask | undefined>
  fetchImpl: KskAutomationFetch
  localAdminFetchImpl?: KskAutomationFetch
  /** 先发消息验活，通过才入库；判死的号返回 rejected=true，不落盘。 */
  importCredential: (
    input: ProviderKskCredential & { groupId?: string; liveness?: KskLivenessOptions }
  ) => Promise<ImportedKskCredential>
  readLocalAdminAccounts: (groupId: string) => Promise<LocalAdminAccount[]>
  cleanupProxyAccounts?: (
    groupId: string | undefined,
    liveness: KskLivenessOptions
  ) => Promise<KskCredentialCleanupResult>
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
  /**
   * 已经发过邮件的 key。
   *
   * 光靠 importCredential 的 added 标志不够：验活误删刚入库的号后，
   * 下一轮同一个 key 会重新入库并再次算作「新增」，导致重复发信。
   * 这里按 key 记账，同一个 key 只通知一次。
   */
  private readonly emailedKeys = new Set<string>()
  /**
   * 发消息验活判为永久失效的 KSK 明文黑名单。
   *
   * 入库验活与全量清理现在同一口径（都发消息），但 Provider 会反复返回同一批号，
   * 每轮都重新验一遍就是白烧 credits。记住判死的号，下一轮直接跳过。
   *
   * 只存在内存里：重启后账号库里本就没有这些号，重新试一次的代价可接受，
   * 也避免把用户后来手动续费修好的号永久拒之门外。
   */
  private readonly invalidKeys = new Set<string>()
  /**
   * 运行日志环形缓冲。
   *
   * 不放在 status 里逐次 spread：status 到处被 `{ ...this.status, ... }` 覆写，
   * 日志混在里面很容易被某个分支的旧快照回滚掉。快照时再拼进去。
   */
  private readonly logs: KskAutomationLogEntry[] = []
  private status: KskAutomationStatus

  constructor(
    private readonly deps: KskAutomationRunnerDeps,
    initialStatus: KskAutomationStatus = EMPTY_STATUS
  ) {
    this.status = { ...initialStatus, running: false, nextRunAt: undefined }
    this.logs.push(...(initialStatus.logs ?? []))
  }

  snapshot(): KskAutomationStatus {
    return { ...this.status, logs: [...this.logs] }
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
    this.log('手动触发立即执行')
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
    this.log('手动触发本机 Admin 同步')
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
      lastRejectedCount: 0,
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
      const liveness: KskLivenessOptions = {
        model: task.config.livenessModel,
        message: task.config.livenessMessage
      }
      let importFailureCount = 0
      // 已判永久失效的 key 直接跳过，别再花 credits 验活一次又被删一次
      const importable = parsed.credentials.filter(
        (credential) => !this.invalidKeys.has(credential.key)
      )
      const importResults = await mapWithConcurrency(
        importable,
        KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
        async (credential, index): Promise<ImportedKskCredential | null> => {
          try {
            return await this.deps.importCredential({
              ...credential,
              groupId: task.config.providerGroupId,
              liveness
            })
          } catch {
            importFailureCount++
            this.log(
              `第 ${index + 1} 条 Provider KSK 验活或入库失败`,
              KSK_AUTOMATION_LOG_LEVEL.WARN
            )
            return null
          }
        }
      )
      const added = importResults.filter((credential): credential is ImportedKskCredential =>
        Boolean(credential?.added)
      )
      // 验活当场判死的号：不入库，直接拉黑，并交给下面一起从反代删掉
      const rejectedKeys = importResults
        .filter((credential) => credential?.rejected)
        .map((credential) => credential!.key)
      for (const key of rejectedKeys) this.invalidKeys.add(key)

      const roundIssues: string[] = []
      /*
       * 本轮确认失效、需要从本机 Admin（kiro-rs 反代）删掉的 key。
       * 包含入库阶段被拒的和全量验活删掉的：前者可能是上一版本遗留在 Admin 上的，
       * 后者是本地刚删的，两边都要清掉才算真正一致。
       */
      const doomedKeys = new Set(rejectedKeys)

      if (added.length > 0) {
        if (task.config.cleanupInvalidOnAdd && this.deps.cleanupProxyAccounts) {
          try {
            const cleanup = await this.deps.cleanupProxyAccounts(
              task.config.providerGroupId,
              liveness
            )
            // 拉黑本轮被删掉的号；同时撤掉待发邮件，避免为一个已被删除的号发通知
            for (const key of cleanup.removedKeys ?? []) {
              this.invalidKeys.add(key)
              this.pendingEmail.delete(key)
              doomedKeys.add(key)
            }
            this.status = {
              ...this.status,
              lastCleanupCheckedCount: cleanup.checked,
              lastCleanupRemovedCount: cleanup.removed,
              lastCleanupRetainedCount: cleanup.retainedTransient
            }
            this.log(`全量验活检查 ${cleanup.checked} 个账号，删除 ${cleanup.removed} 个失效号`)
            roundIssues.push(...cleanup.errors)
            for (const issue of cleanup.errors) {
              this.log(`全量验活：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN)
            }
            if (cleanup.retainedTransient > 0) {
              roundIssues.push(`保留 ${cleanup.retainedTransient} 个暂时无法确认的账号`)
              this.log(
                `保留 ${cleanup.retainedTransient} 个暂时无法确认的账号，待下轮复核`,
                KSK_AUTOMATION_LOG_LEVEL.WARN
              )
            }
          } catch (error) {
            const message = `Proxy RS 清理失败：${error instanceof Error ? error.message : String(error)}`
            roundIssues.push(message)
            this.log(message, KSK_AUTOMATION_LOG_LEVEL.ERROR)
          }
        }

        /*
         * 先删反代上的挂号，再把活号同步上去：反过来会把刚刚验活判死的号推给反代，
         * 中间那一小段时间反代仍会拿它去打上游。
         */
        if (task.config.localAdminEnabled) {
          roundIssues.push(...(await this.deleteFromLocalAdmin(task, [...doomedKeys])))
          this.queueLocalAdminSync()
          while (this.localAdminPromise) await this.localAdminPromise
          roundIssues.push(...this.lastLocalAdminIssues)
        }
        this.deps.notifyAccountsChanged()
      } else if (doomedKeys.size > 0 && task.config.localAdminEnabled) {
        // 一个都没新增但抓出了挂号，反代那边照样得清
        roundIssues.push(...(await this.deleteFromLocalAdmin(task, [...doomedKeys])))
      }

      this.status = {
        ...this.status,
        lastFetchedCount: parsed.credentials.length,
        lastAddedCount: added.length,
        totalAddedCount: this.status.totalAddedCount + added.length,
        lastRejectedCount: rejectedKeys.length
      }

      const skippedCount = parsed.credentials.length - importable.length
      this.log(
        `本轮拉到 ${parsed.credentials.length} 条，新增 ${added.length} 个` +
          (rejectedKeys.length > 0 ? `，验活未通过 ${rejectedKeys.length} 个` : '') +
          (skippedCount > 0 ? `，跳过已知失效 ${skippedCount} 个` : '')
      )
      if (parsed.rejectedCount > 0) {
        this.log(`忽略 ${parsed.rejectedCount} 条无效或重复记录`, KSK_AUTOMATION_LOG_LEVEL.WARN)
      }

      let emailedCount = 0
      if (task.config.emailEnabled) {
        for (const credential of added) {
          // 已通知过的 key 不再入队：清理误删后重新入库不该再发一封
          if (this.emailedKeys.has(credential.key)) continue
          // 本轮清理刚把它删掉的号也不通知：邮件里给一个界面上找不到的号只会误导
          if (this.invalidKeys.has(credential.key)) continue
          this.pendingEmail.set(credential.key, {
            key: credential.key,
            region: credential.region
          })
        }
        const pending = [...this.pendingEmail.values()]
        if (pending.length > 0) {
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
          // 只有发送成功才记账；失败时保留 pendingEmail 供下一轮重试
          for (const credential of pending) this.emailedKeys.add(credential.key)
          this.pendingEmail.clear()
          this.log(`已发送新增通知邮件，包含 ${emailedCount} 个 KSK`)
        }
      } else {
        this.pendingEmail.clear()
      }

      roundIssues.push(
        parsed.rejectedCount > 0 ? `忽略 ${parsed.rejectedCount} 条无效或重复记录` : '',
        rejectedKeys.length > 0 ? `${rejectedKeys.length} 条 KSK 验活未通过，未入库` : '',
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
      this.log(`轮询失败：${message}`, KSK_AUTOMATION_LOG_LEVEL.ERROR)
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

  /** 把本地判死的 key 从本机 Admin 上删掉；返回本次遇到的问题描述。 */
  private async deleteFromLocalAdmin(
    task: PersistedKskAutomationTask,
    keys: readonly string[]
  ): Promise<string[]> {
    if (keys.length === 0) return []
    try {
      const removal = await deleteLocalAdminCredentialsByKey({
        keys,
        baseUrl: task.config.localAdminBaseUrl,
        adminApiKey: task.secrets.localAdminApiKey,
        timeoutSeconds: task.config.requestTimeoutSeconds,
        fetchImpl: this.deps.localAdminFetchImpl ?? this.deps.fetchImpl
      })
      if (removal.removed > 0) this.log(`已从本机 Admin 删除 ${removal.removed} 个失效凭据`)
      for (const issue of removal.errors) {
        this.log(`本机 Admin 删除失效凭据：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN)
      }
      return removal.errors
    } catch (error) {
      const message = `本机 Admin 清理失败：${error instanceof Error ? error.message : String(error)}`
      this.log(message, KSK_AUTOMATION_LOG_LEVEL.ERROR)
      return [message]
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
        // 这里静默返回过一段时间，表现就是「同步从没发生过」，必须留痕
        if (task?.enabled && task.config.localAdminEnabled && !groupId) {
          this.log('未选择同步分组，跳过本机 Admin 同步', KSK_AUTOMATION_LOG_LEVEL.WARN)
          this.pushStatus()
        }
        return
      }
      const accounts = await this.deps.readLocalAdminAccounts(groupId)
      /*
       * 一个都没读到时不做同步：残留清理是无条件的，空列表会把 Admin 上所有 api_key
       * 凭据全删掉。分组选错、分组被删、账号还没导入都会命中这条，代价不对等。
       */
      if (accounts.length === 0) {
        this.lastLocalAdminIssues = []
        this.log(
          '同步分组内没有可用的 Kiro API Key 账号，跳过本轮同步（不清理反代凭据）',
          KSK_AUTOMATION_LOG_LEVEL.WARN
        )
        this.pushStatus()
        return
      }
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
        lastLocalAdminPrunedCount: result.pruned,
        lastError: result.errors.length > 0 ? result.errors.join('；') : this.status.lastError,
        state: result.errors.length > 0 ? KSK_AUTOMATION_STATE.DEGRADED : this.status.state
      }
      this.lastLocalAdminIssues = result.errors
      for (const issue of result.errors) {
        this.log(`本机 Admin 同步：${issue}`, KSK_AUTOMATION_LOG_LEVEL.WARN)
      }
      if (result.pruned > 0) {
        this.log(
          `已从本机 Admin 清理 ${result.pruned} 个本地已不存在的凭据：` +
            result.prunedMaskedKeys.join('、')
        )
      }
      if (result.synced > 0 || result.verified > 0) {
        this.log(`已同步 ${result.synced} 个凭据到本机 Admin，其中 ${result.verified} 个验活通过`)
      }
      if (result.synced === 0 && result.pruned === 0 && result.errors.length === 0) {
        this.log(`本机 Admin 已与本地一致，${result.skippedExisting} 个凭据无需变更`)
      }
      this.pushStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.status = {
        ...this.status,
        state: KSK_AUTOMATION_STATE.DEGRADED,
        lastError: message
      }
      this.lastLocalAdminIssues = [message]
      this.log(`本机 Admin 同步失败：${message}`, KSK_AUTOMATION_LOG_LEVEL.ERROR)
      this.pushStatus()
    }
  }

  private pushStatus(): void {
    this.deps.notifyStatus(this.snapshot())
  }

  private log(message: string, level: KskAutomationLogLevel = KSK_AUTOMATION_LOG_LEVEL.INFO): void {
    this.logs.push({ at: Date.now(), level, message })
    if (this.logs.length > KSK_AUTOMATION_LOG_LIMIT) {
      this.logs.splice(0, this.logs.length - KSK_AUTOMATION_LOG_LIMIT)
    }
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
    // logs 单独复制：浅拷贝会让所有未启动任务共享 EMPTY_STATUS 的那一个数组
    return this.runners.get(taskId)?.snapshot() ?? { ...EMPTY_STATUS, logs: [] }
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
