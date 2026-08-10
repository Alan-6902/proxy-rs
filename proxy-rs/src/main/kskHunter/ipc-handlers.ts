import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  KSK_HUNTER_MODE,
  type KskHunterConfig,
  type KskHunterLinkInput,
  type KskHunterSecretInput,
  type KskHunterSnapshot,
  type KskHunterStatusEvent
} from '../../shared/kskHunter'
import type { HunterReport } from '../../shared/hunterReport'
import type { KskLedgerReport, KskLedgerSort } from '../../shared/kskLedger'
import { hunterReportStorePath } from './reportStore'
import { clearKskLedger, kskLedgerStorePath } from './ledgerStore'
import {
  createKskHunterLink,
  deleteKskHunterDelivery,
  deleteKskHunterLink,
  isKskHunterStoreAvailable,
  loadKskHunterStore,
  setKskHunterLinkEnabled,
  toKskHunterConfigView,
  updateKskHunterConfig,
  updateKskHunterLink
} from './configStore'
import { resolveDownstreamBase } from './downstreamClient'
import { buildKskHunterSnapshotParts, type KskHunterManager } from './hunterRunner'

export const KSK_HUNTER_CHANNEL_NAME = {
  snapshot: 'ksk-hunter-snapshot',
  updateConfig: 'ksk-hunter-update-config',
  createLink: 'ksk-hunter-create-link',
  updateLink: 'ksk-hunter-update-link',
  setLinkEnabled: 'ksk-hunter-set-link-enabled',
  deleteLink: 'ksk-hunter-delete-link',
  runNow: 'ksk-hunter-run-now',
  retryDelivery: 'ksk-hunter-retry-delivery',
  deleteDelivery: 'ksk-hunter-delete-delivery',
  report: 'ksk-hunter-report',
  revealReportFile: 'ksk-hunter-reveal-report-file',
  ledgerReport: 'ksk-hunter-ledger-report',
  clearLedger: 'ksk-hunter-clear-ledger',
  revealLedgerFile: 'ksk-hunter-reveal-ledger-file',
  statusEvent: 'ksk-hunter-status-changed'
} as const

interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

export interface KskHunterIpcDeps {
  getManager: () => KskHunterManager
  getMainWindow: () => BrowserWindow | null
}

function toError(error: unknown): IpcResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

async function buildSnapshot(manager: KskHunterManager): Promise<KskHunterSnapshot> {
  const store = await loadKskHunterStore()
  const { links, deliveries } = buildKskHunterSnapshotParts(store, manager)
  return {
    config: toKskHunterConfigView(store),
    links,
    status: manager.snapshotStatus(),
    deliveries,
    spend: await manager.spendSummary(store),
    balances: manager.channelBalances(store)
  }
}

/** 推送轻量事件（不含 config）给渲染进程。 */
export async function sendKskHunterStatus(
  getMainWindow: () => BrowserWindow | null,
  manager: KskHunterManager
): Promise<void> {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const store = await loadKskHunterStore()
  const { links, deliveries } = buildKskHunterSnapshotParts(store, manager)
  const event: KskHunterStatusEvent = {
    status: manager.snapshotStatus(),
    links,
    deliveries,
    spend: await manager.spendSummary(store),
    balances: manager.channelBalances(store)
  }
  win.webContents.send(KSK_HUNTER_CHANNEL_NAME.statusEvent, event)
}

function validateLinkInput(input: KskHunterLinkInput, hasExistingOrderUrl: boolean): void {
  if (!input.name.trim()) throw new Error('请输入链接名称')
  const listUrl = input.listUrl?.trim()
  if (listUrl) {
    const parsed = new URL(listUrl)
    if (parsed.protocol !== 'https:') throw new Error('商品列表地址必须使用 HTTPS')
  }
  const orderUrl = input.orderUrl?.trim()
  if (orderUrl) {
    const parsed = new URL(orderUrl)
    if (parsed.protocol !== 'https:') throw new Error('下单地址必须使用 HTTPS')
  }
  if (input.mode === KSK_HUNTER_MODE.AUTO_ORDER && !orderUrl && !hasExistingOrderUrl) {
    throw new Error('自动下单模式必须配置下单地址')
  }
}

function validateConfig(
  config: Partial<KskHunterConfig>,
  secrets: KskHunterSecretInput | undefined,
  hasExistingApiKey: boolean
): void {
  // 余额地址必须是 HTTPS：它带 token，且响应决定要不要花钱
  for (const url of Object.values(secrets?.balanceUrls ?? {})) {
    const trimmed = url?.trim()
    if (!trimmed) continue
    if (new URL(trimmed).protocol !== 'https:') {
      throw new Error('余额查询地址必须使用 HTTPS')
    }
  }
  if (!config.downstreamEnabled) return
  const baseUrl = config.downstreamBaseUrl?.trim()
  if (!baseUrl) throw new Error('开启下游推送前请填写下游地址')
  resolveDownstreamBase(baseUrl)
  const apiKey = secrets?.downstreamApiKey
  const willHaveKey = apiKey === undefined ? hasExistingApiKey : Boolean(apiKey.trim())
  if (!willHaveKey) throw new Error('开启下游推送前请填写下游 API Key')
}

export function registerKskHunterIpcHandlers(deps: KskHunterIpcDeps): void {
  const respondSnapshot = async (): Promise<IpcResult<KskHunterSnapshot>> => ({
    success: true,
    data: await buildSnapshot(deps.getManager())
  })

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.snapshot, async () => {
    try {
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.updateConfig,
    async (_event, config: Partial<KskHunterConfig>, secrets?: KskHunterSecretInput) => {
      try {
        if (!isKskHunterStoreAvailable()) throw new Error('系统加密存储不可用')
        const current = await loadKskHunterStore()
        validateConfig(
          { ...current.config, ...config },
          secrets,
          Boolean(current.secrets.downstreamApiKey)
        )
        await updateKskHunterConfig(config, secrets)
        await deps.getManager().reload()
        return await respondSnapshot()
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.createLink, async (_event, input: KskHunterLinkInput) => {
    try {
      if (!isKskHunterStoreAvailable()) throw new Error('系统加密存储不可用')
      if (!input.listUrl?.trim()) throw new Error('请填写商品列表地址')
      validateLinkInput(input, false)
      await createKskHunterLink(randomUUID(), input)
      await deps.getManager().reload()
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.updateLink,
    async (_event, linkId: string, input: KskHunterLinkInput) => {
      try {
        const current = await loadKskHunterStore()
        const link = current.links.find((item) => item.id === linkId)
        if (!link) throw new Error('链接不存在或已删除')
        if (input.listUrl !== undefined && !input.listUrl.trim() && !link.secrets.listUrl) {
          throw new Error('请填写商品列表地址')
        }
        validateLinkInput(input, Boolean(link.secrets.orderUrl))
        await updateKskHunterLink(linkId, input)
        await deps.getManager().reload()
        return await respondSnapshot()
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.setLinkEnabled,
    async (_event, linkId: string, enabled: boolean) => {
      try {
        await setKskHunterLinkEnabled(linkId, enabled)
        await deps.getManager().reload()
        return await respondSnapshot()
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.deleteLink, async (_event, linkId: string) => {
    try {
      await deleteKskHunterLink(linkId)
      await deps.getManager().reload()
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.runNow, async () => {
    try {
      await deps.getManager().runNow()
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.retryDelivery, async (_event, deliveryId: string) => {
    try {
      await deps.getManager().retryDelivery(deliveryId)
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.deleteDelivery, async (_event, deliveryId: string) => {
    try {
      await deleteKskHunterDelivery(deliveryId)
      return await respondSnapshot()
    } catch (error) {
      return toError(error)
    }
  })

  // 报表要读整份事件流并聚合，比状态快照重，所以单独一个通道按需拉，
  // 不挂在 3 秒一次的状态事件上
  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.report,
    async (_event, days?: number): Promise<IpcResult<HunterReport>> => {
      try {
        return { success: true, data: await deps.getManager().report(days) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.revealReportFile, async (): Promise<IpcResult<string>> => {
    try {
      const path = hunterReportStorePath()
      // 没攒到事件时文件还不存在，showItemInFolder 会静默失败，
      // 所以先确认存在再打开，不存在就把原因回给 UI
      await fs.access(path)
      shell.showItemInFolder(path)
      return { success: true, data: path }
    } catch {
      return { success: false, error: '报表历史文件还不存在，抢号产生第一条记录后才会生成' }
    }
  })

  // 台账与抢号报表各读一份文件、各自聚合，所以分开两个通道按需拉
  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.ledgerReport,
    async (_event, days?: number, sort?: KskLedgerSort): Promise<IpcResult<KskLedgerReport>> => {
      try {
        return { success: true, data: await deps.getManager().ledgerReport(days, sort) }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(
    KSK_HUNTER_CHANNEL_NAME.clearLedger,
    async (): Promise<IpcResult<KskLedgerReport>> => {
      try {
        await clearKskLedger()
        return { success: true, data: await deps.getManager().ledgerReport() }
      } catch (error) {
        return toError(error)
      }
    }
  )

  ipcMain.handle(KSK_HUNTER_CHANNEL_NAME.revealLedgerFile, async (): Promise<IpcResult<string>> => {
    try {
      const path = kskLedgerStorePath()
      await fs.access(path)
      shell.showItemInFolder(path)
      return { success: true, data: path }
    } catch {
      return { success: false, error: '台账文件还不存在，抢到第一个号后才会生成' }
    }
  })
}
