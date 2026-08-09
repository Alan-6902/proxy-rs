import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type {
  KskAutomationStatusEvent,
  KskAutomationTaskInput,
  KskAutomationTaskView
} from '../../shared/kskAutomation'
import type { LocalAdminPushCandidate, LocalAdminPushResult } from '../../shared/localAdminPush'
import {
  createKskAutomationTask,
  deleteKskAutomationTask,
  isKskAutomationStoreAvailable,
  loadKskAutomationStore,
  loadKskAutomationTask,
  normalizeKskAutomationConfig,
  setKskAutomationTaskEnabled,
  toKskAutomationTaskView,
  updateKskAutomationTask,
  type KskAutomationSecrets,
  type PersistedKskAutomationTask
} from './configStore'
import { parseKskEmailRecipients } from './emailNotifier'
import {
  pushAccountToLocalAdmin,
  resolveLocalAdminApiBase,
  type KskAutomationFetch,
  type LocalAdminProbeOutcome
} from './localAdminClient'
import type { KskAutomationManager } from './syncManager'

export const KSK_AUTOMATION_CHANNEL = {
  list: 'ksk-automation-list',
  create: 'ksk-automation-create',
  update: 'ksk-automation-update',
  setEnabled: 'ksk-automation-set-enabled',
  delete: 'ksk-automation-delete',
  syncNow: 'ksk-automation-sync-now',
  syncLocalAdminNow: 'ksk-automation-sync-local-admin-now',
  cleanupNow: 'ksk-automation-cleanup-now',
  pushAccountToLocalAdmin: 'ksk-automation-push-account-to-local-admin',
  statusEvent: 'ksk-automation-status-changed',
  accountsChangedEvent: 'ksk-automation-accounts-changed'
} as const

interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

export interface KskAutomationIpcDeps {
  getManager: () => KskAutomationManager
  getMainWindow: () => BrowserWindow | null
  /** 直连本机 Admin 的 fetch（不走应用代理），与自动同步链路共用同一实现。 */
  localAdminFetchImpl: KskAutomationFetch
  /** 推进 Admin 后用同一份凭据发一条消息验活；判死时调用方会回滚删除该凭据。 */
  probeLocalAdminPushLiveness: (
    candidate: LocalAdminPushCandidate
  ) => Promise<LocalAdminProbeOutcome>
}

function sendEvent(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  payload?: unknown
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function sendKskAutomationStatus(
  getMainWindow: () => BrowserWindow | null,
  event: KskAutomationStatusEvent
): void {
  sendEvent(getMainWindow, KSK_AUTOMATION_CHANNEL.statusEvent, event)
}

export function sendKskAutomationAccountsChanged(getMainWindow: () => BrowserWindow | null): void {
  sendEvent(getMainWindow, KSK_AUTOMATION_CHANNEL.accountsChangedEvent)
}

function mergedSecrets(
  current: KskAutomationSecrets,
  input: KskAutomationTaskInput['secrets']
): KskAutomationSecrets {
  return {
    providerUrl: input?.providerUrl === undefined ? current.providerUrl : input.providerUrl.trim(),
    smtpPassword:
      input?.smtpPassword === undefined ? current.smtpPassword : input.smtpPassword.trim(),
    localAdminApiKey:
      input?.localAdminApiKey === undefined
        ? current.localAdminApiKey
        : input.localAdminApiKey.trim()
  }
}

async function validateEnabledTask(task: PersistedKskAutomationTask): Promise<void> {
  if (!task.name.trim()) throw new Error('请输入任务名称')
  if (!task.enabled) return
  if (task.config.providerEnabled) {
    if (!task.secrets.providerUrl) throw new Error('开启任务前请配置 KSK Provider URL')
    const providerUrl = new URL(task.secrets.providerUrl)
    if (providerUrl.protocol !== 'https:') throw new Error('KSK Provider URL 必须使用 HTTPS')
  }
  if (task.config.emailEnabled) {
    const hasRecipient = parseKskEmailRecipients(task.config.smtpTo).length > 0
    if (!task.config.smtpHost || !task.config.smtpFrom || !hasRecipient) {
      throw new Error('开启邮件通知前请填写 SMTP Host、发件人和收件人')
    }
    if (task.config.smtpUsername && !task.secrets.smtpPassword) {
      throw new Error('SMTP 用户名已配置，请填写 SMTP 密码')
    }
  }
  if (task.config.localAdminEnabled) {
    if (!task.config.localAdminGroupId) throw new Error('请选择要同步到本机 Admin 的分组')
    if (!task.secrets.localAdminApiKey) throw new Error('开启本机同步前请填写 Admin API Key')
    resolveLocalAdminApiBase(task.config.localAdminBaseUrl)
  }
}

async function listTaskViews(manager: KskAutomationManager): Promise<KskAutomationTaskView[]> {
  const store = await loadKskAutomationStore()
  return store.tasks.map((task) => toKskAutomationTaskView(task, manager.snapshot(task.id)))
}

function toError(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * 单账号推送到本机 Admin 的日志分类。
 *
 * 走 console 是这个仓库既有的日志出口：主进程的 console 被 interceptConsole 拦下来
 * 转进 proxyLogStore，日志页按 `[分类]` 前缀分组展示（同 LocalAdminStats 的做法）。
 */
const LOCAL_ADMIN_PUSH_LOG_CATEGORY = 'LocalAdminPush'

function logLocalAdminPush(message: string): void {
  console.log(`[${LOCAL_ADMIN_PUSH_LOG_CATEGORY}] ${message}`)
}

function logLocalAdminPushError(message: string): void {
  console.error(`[${LOCAL_ADMIN_PUSH_LOG_CATEGORY}] ${message}`)
}

/**
 * 推送目标账号的可辨识描述，不含任何凭据明文。
 *
 * 手动推送的 candidate 里没有 email/id（只有凭据字段），所以用「凭据类型 + 认证方式 + 区域」
 * 定位是哪一次点击；同一时刻只会有一次手动推送，这些信息足够对上账号卡片。
 */
function describePushCandidate(candidate: LocalAdminPushCandidate): string {
  const kind =
    candidate.credentialKind === 'kiro_api_key' || candidate.kiroApiKey ? 'api_key' : 'oauth'
  const authMethod = candidate.authMethod ?? '未声明'
  return `${kind} / authMethod=${authMethod} / region=${candidate.region?.trim() || '未填'}`
}

export interface LocalAdminTarget {
  baseUrl: string
  adminApiKey: string
  timeoutSeconds: number
  /** 反代统计采到用量后是否自动删掉额度耗尽的凭据，取自同一条任务配置。 */
  autoDeleteExhausted: boolean
}

/**
 * 从已有任务里取本机 Admin 连接信息，供单账号手动推送与反代统计复用。
 * 启用中的任务优先；仅暂停的任务配置仍然可用（暂停停的是轮询，不是这份地址）。
 */
export async function resolveLocalAdminTarget(): Promise<LocalAdminTarget> {
  const store = await loadKskAutomationStore()
  const candidates = store.tasks.filter(
    (task) => task.config.localAdminEnabled && task.secrets.localAdminApiKey
  )
  const task = candidates.find((item) => item.enabled) ?? candidates[0]
  if (!task) {
    throw new Error(
      '未找到可用的本机 Admin 配置，请先在任务管理里开启「同步到本机 Admin」并填写 Admin API Key'
    )
  }
  return {
    baseUrl: task.config.localAdminBaseUrl,
    adminApiKey: task.secrets.localAdminApiKey,
    timeoutSeconds: task.config.requestTimeoutSeconds,
    autoDeleteExhausted: task.config.autoDeleteExhausted
  }
}

export function registerKskAutomationIpcHandlers(deps: KskAutomationIpcDeps): void {
  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.list,
    async (): Promise<IpcResult<KskAutomationTaskView[]>> => {
      try {
        return { success: true, data: await listTaskViews(deps.getManager()) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.create,
    async (_event, input: KskAutomationTaskInput): Promise<IpcResult<KskAutomationTaskView[]>> => {
      try {
        if (!isKskAutomationStoreAvailable()) throw new Error('系统加密存储不可用')
        const task: PersistedKskAutomationTask = {
          id: randomUUID(),
          name: input.name.trim(),
          type: 'ksk_pull',
          enabled: input.enabled !== false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          config: normalizeKskAutomationConfig(input.config),
          secrets: mergedSecrets(
            { providerUrl: '', smtpPassword: '', localAdminApiKey: '' },
            input.secrets
          )
        }
        await validateEnabledTask(task)
        await createKskAutomationTask(task.id, input)
        await deps.getManager().reloadTask(task.id)
        return { success: true, data: await listTaskViews(deps.getManager()) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.update,
    async (
      _event,
      taskId: string,
      input: KskAutomationTaskInput
    ): Promise<IpcResult<KskAutomationTaskView[]>> => {
      try {
        const current = await loadKskAutomationTask(taskId)
        if (!current) throw new Error('任务不存在或已删除')
        const candidate: PersistedKskAutomationTask = {
          ...current,
          name: input.name.trim(),
          enabled: input.enabled ?? current.enabled,
          config: normalizeKskAutomationConfig({ ...current.config, ...input.config }),
          secrets: mergedSecrets(current.secrets, input.secrets),
          updatedAt: Date.now()
        }
        await validateEnabledTask(candidate)
        await updateKskAutomationTask(taskId, input)
        await deps.getManager().reloadTask(taskId)
        return { success: true, data: await listTaskViews(deps.getManager()) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.setEnabled,
    async (
      _event,
      taskId: string,
      enabled: boolean
    ): Promise<IpcResult<KskAutomationTaskView[]>> => {
      try {
        const current = await loadKskAutomationTask(taskId)
        if (!current) throw new Error('任务不存在或已删除')
        await validateEnabledTask({ ...current, enabled })
        await setKskAutomationTaskEnabled(taskId, enabled)
        await deps.getManager().reloadTask(taskId)
        return { success: true, data: await listTaskViews(deps.getManager()) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.delete,
    async (_event, taskId: string): Promise<IpcResult<KskAutomationTaskView[]>> => {
      try {
        await deleteKskAutomationTask(taskId)
        deps.getManager().removeTask(taskId)
        return { success: true, data: await listTaskViews(deps.getManager()) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.syncNow,
    async (_event, taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().runNow(taskId) }
        }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.syncLocalAdminNow,
    async (_event, taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().syncLocalAdminNow(taskId) }
        }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.cleanupNow,
    async (_event, taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> => {
      try {
        return {
          success: true,
          data: { taskId, status: await deps.getManager().cleanupNow(taskId) }
        }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_AUTOMATION_CHANNEL.pushAccountToLocalAdmin,
    async (
      _event,
      candidate: LocalAdminPushCandidate
    ): Promise<IpcResult<LocalAdminPushResult>> => {
      /*
       * 这条链路必须留日志：失败原因原先只回给渲染进程塞进按钮的 title，
       * 而按钮几秒后就恢复初始态，等于用户根本没有机会读到失败原因。
       * 两道门禁（Admin 余额 + 发消息验活）任一不过都会回滚删凭据，
       * 排查时需要知道是哪一步、报了什么。
       */
      const who = describePushCandidate(candidate)
      logLocalAdminPush(`开始推送账号到本机 Admin：${who}`)
      try {
        const target = await resolveLocalAdminTarget()
        const result = await pushAccountToLocalAdmin({
          candidate,
          baseUrl: target.baseUrl,
          adminApiKey: target.adminApiKey,
          timeoutSeconds: target.timeoutSeconds,
          fetchImpl: deps.localAdminFetchImpl,
          probeLiveness: deps.probeLocalAdminPushLiveness
        })
        logLocalAdminPush(
          result.status === 'existing'
            ? `Admin 已有同一凭据，未新建（#${result.credentialId ?? '未知'}）：${who}`
            : `推送成功并验证可用（#${result.credentialId ?? '未知'}，验活=${result.probeVerdict}）：${who}`
        )
        return { success: true, data: result }
      } catch (error) {
        const failure = toError(error)
        logLocalAdminPushError(`推送失败：${failure.error}（${who}）`)
        return failure
      }
    }
  )
}
