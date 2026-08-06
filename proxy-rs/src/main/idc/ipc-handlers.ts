// IdC 席位管理 IPC
//
// 在主进程 index.ts 里调用 registerIdcIpcHandlers(() => mainWindow) 完成接线。

import { ipcMain, type BrowserWindow } from 'electron'
import { listAwsProfiles, resolveCredentials } from './credentials'
import {
  clearCredentialConfig,
  isCredentialStoreAvailable,
  loadCredentialConfig,
  saveCredentialConfig
} from './credentialStore'
import { normalizeTier, planSeats, MAX_SEATS_PER_PLAN } from './seatPlanner'
import {
  changeTiers,
  deleteSeats,
  fetchSeatInventory,
  provisionSeats,
  resendPasswordEmails,
  unsubscribeSeats,
  type BatchOpTarget,
  type SeatProgressEvent
} from './seatManager'
import type {
  IdcCredentialConfig,
  KiroTier,
  PlannedSeat,
  ResolvedCredentials,
  SeatQuotaRequest
} from './types'

/** IPC 频道名集中定义，避免主进程/preload 两处字符串漂移 */
export const IDC_CHANNEL = {
  credentialStatus: 'idc-credential-status',
  saveCredentials: 'idc-save-credentials',
  clearCredentials: 'idc-clear-credentials',
  listProfiles: 'idc-list-profiles',
  testConnection: 'idc-test-connection',
  planSeats: 'idc-plan-seats',
  provision: 'idc-provision',
  cancelProvision: 'idc-cancel-provision',
  inventory: 'idc-inventory',
  changeTier: 'idc-change-tier',
  unsubscribe: 'idc-unsubscribe',
  deleteSeats: 'idc-delete-seats',
  resendPassword: 'idc-resend-password',
  progressEvent: 'idc-progress'
} as const

type IpcResult<T> = { success: true; data: T } | { success: false; error: string }

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function fail(err: unknown): IpcResult<never> {
  return { success: false, error: err instanceof Error ? err.message : String(err) }
}

/** 当前进行中的开通任务，用于取消。同一时间只允许一个批次，避免重复烧钱 */
let activeProvision: AbortController | null = null

export function registerIdcIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  const sendProgress = (event: SeatProgressEvent): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IDC_CHANNEL.progressEvent, event)
    }
  }

  /**
   * 每次操作都重新解析凭据：手填模式下前端持有明文，profile 模式下
   * ~/.aws 可能在会话期间被改动，缓存反而容易用到失效凭据。
   */
  const credentialsFor = async (config: IdcCredentialConfig): Promise<ResolvedCredentials> =>
    resolveCredentials(config)

  // ---- 凭据管理 ----

  ipcMain.handle(IDC_CHANNEL.credentialStatus, async () => {
    const saved = await loadCredentialConfig()
    return ok({
      encryptionAvailable: isCredentialStoreAvailable(),
      hasSaved: Boolean(saved),
      // 只回传非敏感字段，密钥不出主进程
      source: saved?.source,
      region: saved?.region,
      profile: saved?.profile,
      accessKeyIdTail: saved?.accessKeyId ? saved.accessKeyId.slice(-4) : undefined
    })
  })

  ipcMain.handle(IDC_CHANNEL.saveCredentials, async (_e, config: IdcCredentialConfig) => {
    try {
      await saveCredentialConfig(config)
      return ok({ saved: true })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IDC_CHANNEL.clearCredentials, async () => {
    await clearCredentialConfig()
    return ok({ cleared: true })
  })

  ipcMain.handle(IDC_CHANNEL.listProfiles, async () => {
    try {
      return ok(await listAwsProfiles())
    } catch (err) {
      return fail(err)
    }
  })

  /** 连通性自检：验证凭据能签名、能读到 Identity Center 实例 */
  ipcMain.handle(IDC_CHANNEL.testConnection, async (_e, config: IdcCredentialConfig) => {
    try {
      const credentials = await credentialsFor(config)
      const inventory = await fetchSeatInventory(credentials)
      return ok({
        identityStoreId: inventory.identityStoreId,
        region: credentials.region,
        seatCount: inventory.seats.length,
        unsubscribedCount: inventory.unsubscribedUsers.length
      })
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 席位计划 ----

  ipcMain.handle(
    IDC_CHANNEL.planSeats,
    async (
      _e,
      input: {
        credentials: IdcCredentialConfig
        quotas: { tier: string; count: number }[]
        domains: string
        /** 是否读取现有用户以避免撞号并接续序号。默认 true */
        avoidExisting?: boolean
      }
    ) => {
      try {
        const quotas: SeatQuotaRequest[] = input.quotas
          .filter((q) => Number(q.count) > 0)
          .map((q) => ({ tier: normalizeTier(q.tier), count: Math.floor(Number(q.count)) }))

        let takenEmails: string[] = []
        const seqStart: Partial<Record<KiroTier, number>> = {}

        if (input.avoidExisting !== false) {
          try {
            const credentials = await credentialsFor(input.credentials)
            const inventory = await fetchSeatInventory(credentials)
            const all = [...inventory.seats, ...inventory.unsubscribedUsers]
            takenEmails = all.flatMap((u) => [u.username, u.email].filter(Boolean))
            // 按档位接续序号，避免与已有 pro-001 重号造成对账混乱
            for (const quota of quotas) {
              const existing = inventory.seats.filter((s) => s.tier === quota.tier).length
              seqStart[quota.tier] = existing + 1
            }
          } catch (err) {
            // 读不到现有数据不阻断生成，只是可能撞号；把原因回传让前端提示
            sendProgress({
              kind: 'log',
              message: `读取现有席位失败，本次不做去重与序号接续：${err instanceof Error ? err.message : String(err)}`
            })
          }
        }

        const seats = planSeats({
          quotas,
          domains: input.domains,
          takenEmails,
          seqStart
        })
        return ok({ seats, maxPerPlan: MAX_SEATS_PER_PLAN })
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- 执行开通 ----

  ipcMain.handle(
    IDC_CHANNEL.provision,
    async (
      _e,
      input: {
        credentials: IdcCredentialConfig
        seats: PlannedSeat[]
        sendPasswordEmail: boolean
        concurrency?: number
      }
    ) => {
      if (activeProvision) {
        return fail(new Error('已有开通任务进行中，请等待完成或先取消'))
      }
      const controller = new AbortController()
      activeProvision = controller
      try {
        const credentials = await credentialsFor(input.credentials)
        const summary = await provisionSeats({
          credentials,
          seats: input.seats,
          sendPasswordEmail: input.sendPasswordEmail,
          concurrency: input.concurrency,
          onProgress: sendProgress,
          signal: controller.signal
        })
        return ok(summary)
      } catch (err) {
        return fail(err)
      } finally {
        activeProvision = null
      }
    }
  )

  ipcMain.handle(IDC_CHANNEL.cancelProvision, async () => {
    activeProvision?.abort()
    return ok({ cancelled: Boolean(activeProvision) })
  })

  // ---- 查询 ----

  ipcMain.handle(IDC_CHANNEL.inventory, async (_e, config: IdcCredentialConfig) => {
    try {
      const credentials = await credentialsFor(config)
      return ok(await fetchSeatInventory(credentials))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 批量维护 ----

  ipcMain.handle(
    IDC_CHANNEL.changeTier,
    async (
      _e,
      input: {
        credentials: IdcCredentialConfig
        targets: BatchOpTarget[]
        tier: string
        concurrency?: number
      }
    ) => {
      try {
        const credentials = await credentialsFor(input.credentials)
        const results = await changeTiers({
          credentials,
          targets: input.targets,
          tier: normalizeTier(input.tier),
          concurrency: input.concurrency,
          onProgress: sendProgress
        })
        return ok(results)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IDC_CHANNEL.unsubscribe,
    async (
      _e,
      input: { credentials: IdcCredentialConfig; targets: BatchOpTarget[]; concurrency?: number }
    ) => {
      try {
        const credentials = await credentialsFor(input.credentials)
        const results = await unsubscribeSeats({
          credentials,
          targets: input.targets,
          concurrency: input.concurrency,
          onProgress: sendProgress
        })
        return ok(results)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IDC_CHANNEL.deleteSeats,
    async (
      _e,
      input: { credentials: IdcCredentialConfig; targets: BatchOpTarget[]; concurrency?: number }
    ) => {
      try {
        const credentials = await credentialsFor(input.credentials)
        // identityStoreId 从实例现查，避免前端传错造成跨 store 删除
        const inventory = await fetchSeatInventory(credentials)
        const results = await deleteSeats({
          credentials,
          identityStoreId: inventory.identityStoreId,
          targets: input.targets,
          concurrency: input.concurrency,
          onProgress: sendProgress
        })
        return ok(results)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IDC_CHANNEL.resendPassword,
    async (
      _e,
      input: { credentials: IdcCredentialConfig; targets: BatchOpTarget[]; concurrency?: number }
    ) => {
      try {
        const credentials = await credentialsFor(input.credentials)
        const results = await resendPasswordEmails({
          credentials,
          targets: input.targets,
          concurrency: input.concurrency,
          onProgress: sendProgress
        })
        return ok(results)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
