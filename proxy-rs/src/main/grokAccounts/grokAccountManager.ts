/**
 * Grok 账号切换的业务编排：列出可切的号（Grok 客户端里的 ∪ Cursor 账号库里的）、识别当前号、一键切号
 * 并把 relay 同步到新号的 box、从客户端移除号。
 *
 * 切号流程（与 Cursor 切号同构）：Grok 在运行时先返回 needsClose 让界面确认 → 退出客户端 →（目标号
 * 还不在 Grok 里就先从 Cursor 账号库写进 sand-secrets）→ 改 active → 重启客户端 → 把反代的
 * grok-box-relay.json 指向新号的 box。最后一步是本机全走 Grok 代理时的关键：不同步 relay，反代仍打
 * 旧号的 box，切号就等于没切。
 *
 * 所有改 sand-secrets 的动作都挤在「退出 → 写 → 重开」这一次里：客户端把文件缓存在内存、每次自己写盘
 * 都整体覆盖，运行中写进去的内容会被它下次写盘抹掉（见 shared/grokAccounts.ts 头注释）。
 */

import {
  getCursorBotUsage,
  getCursorPlanDisplayName,
  getCursorPlanTone,
  isCursorAccountBanned,
  type CursorAccount
} from '../../shared/cursorAccounts'
import type {
  GrokAccountCursorInfo,
  GrokAccountView,
  GrokRemoveResult,
  GrokSwitchResult
} from '../../shared/grokAccounts'
import { loadCursorAccounts } from '../cursorAccounts/accountStore'
import {
  grokAccountScope,
  isGrokRunning,
  launchGrok,
  quitGrok,
  readActiveGrokAccountScope,
  readGrokAccounts,
  removeGrokAccount,
  setActiveGrokAccount,
  upsertGrokAccount,
  type GrokAccount,
  type GrokImportPayload
} from './grokLocalState'
import { listBoxScopes, readBoxSavedAt, syncRelayToAccount } from './grokRelay'

/** 列出切号页的全部卡片：Grok 客户端里已登录的号，加上 Cursor 账号库里还没进 Grok 的正常号。 */
export async function listGrokAccounts(): Promise<GrokAccountView[]> {
  const [accounts, cursorAccounts] = await Promise.all([
    readGrokAccounts(),
    loadCursorAccountsSafe()
  ])
  return buildGrokAccountViews(accounts, listBoxScopes(), cursorAccounts)
}

/** 账号库只是补充数据源：读不到就当空库，不能连带把 Grok 账号列表也拖垮。 */
async function loadCursorAccountsSafe(): Promise<CursorAccount[]> {
  try {
    return await loadCursorAccounts()
  } catch (error) {
    console.warn(
      `[GrokAccounts] 读取 Cursor 账号库失败，只列 Grok 里的号: ${error instanceof Error ? error.message : String(error)}`
    )
    return []
  }
}

/**
 * Cursor 账号库按 Grok 的 scope 规则（sha256(jwt.sub)）建索引，同一个人的两份凭据自然对上。
 * 没有 access token 的号算不出 scope、也写不进 Grok，直接略过。
 */
export function indexCursorAccountsByScope(
  cursorAccounts: CursorAccount[]
): Map<string, CursorAccount> {
  const byScope = new Map<string, CursorAccount>()
  for (const account of cursorAccounts) {
    if (account.accessToken) byScope.set(grokAccountScope(account.accessToken), account)
  }
  return byScope
}

/**
 * 把 Grok 账号、box 台账、Cursor 账号库拼成卡片列表。Grok 里的号全列并带上账号库里的订阅/额度；
 * 账号库里还没进 Grok 的号也列出来（inGrok=false），切换时顺手写入。封禁号切过去也用不了，不列。
 * 纯函数，方便单测。
 */
export function buildGrokAccountViews(
  accounts: Pick<GrokAccount, 'scope' | 'email' | 'name'>[],
  boxScopes: Map<string, number>,
  cursorAccounts: CursorAccount[]
): GrokAccountView[] {
  const cursorByScope = indexCursorAccountsByScope(cursorAccounts)
  const views: GrokAccountView[] = accounts.map((account) => {
    const cursorAccount = cursorByScope.get(account.scope)
    return {
      scope: account.scope,
      email: account.email,
      name: account.name,
      inGrok: true,
      hasBox: boxScopes.has(account.scope),
      boxSavedAt: boxScopes.get(account.scope),
      cursor: cursorAccount ? summarizeCursorAccount(cursorAccount) : undefined
    }
  })
  const grokScopes = new Set(accounts.map((account) => account.scope))
  for (const [scope, cursorAccount] of cursorByScope) {
    if (grokScopes.has(scope) || isCursorAccountBanned(cursorAccount)) continue
    views.push({
      scope,
      email: cursorAccount.email || undefined,
      name: cursorAccount.name,
      inGrok: false,
      hasBox: boxScopes.has(scope),
      boxSavedAt: boxScopes.get(scope),
      cursor: summarizeCursorAccount(cursorAccount)
    })
  }
  return views
}

function summarizeCursorAccount(account: CursorAccount): GrokAccountCursorInfo {
  return {
    planName: getCursorPlanDisplayName(account),
    planTone: getCursorPlanTone(account),
    subscriptionStatus: account.subscriptionStatus,
    botUsage: getCursorBotUsage(account),
    usageUpdatedAt: account.usageUpdatedAt
  }
}

function toGrokImportPayload(account: CursorAccount): GrokImportPayload {
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    email: account.email || undefined,
    name: account.name
  }
}

/** 当前激活账号的 scope；未登录任何号返回 null。 */
export function resolveCurrentGrokScope(): string | null {
  return readActiveGrokAccountScope() ?? null
}

/**
 * 切到指定账号。Grok 运行且未确认关闭时先返回 needsClose。确认后：退出 →（不在 Grok 里就先从 Cursor
 * 账号库写入）→ 改 active → 同步 relay → 重启。relay 同步失败（多为该号还没建 box）不算切号失败，用
 * relaySynced=false 告知界面。
 */
export async function switchGrokAccount(
  scope: string,
  options: { closeGrok?: boolean } = {}
): Promise<GrokSwitchResult> {
  const accounts = await readGrokAccounts()
  const inGrok = accounts.some((account) => account.scope === scope)
  const cursorAccount = inGrok
    ? undefined
    : indexCursorAccountsByScope(await loadCursorAccountsSafe()).get(scope)
  if (!inGrok && !cursorAccount) {
    throw new Error(`Grok 客户端和 Cursor 账号库里都没有这个号: ${scope}`)
  }
  if (cursorAccount && isCursorAccountBanned(cursorAccount)) {
    throw new Error('这个号在 Cursor 账号库里已标记封禁，不写进 Grok')
  }

  const running = await isGrokRunning()
  if (running && !options.closeGrok) {
    return { status: 'needsClose', scope }
  }
  if (running) await quitGrok()

  if (cursorAccount) await upsertGrokAccount(toGrokImportPayload(cursorAccount))
  await setActiveGrokAccount(scope)

  // relay 要在客户端退出后、用已在盘上的 descriptor 同步：此刻 box 连接是目标号最后一次活跃时写下的。
  let relaySynced = false
  try {
    await syncRelayToAccount(scope)
    relaySynced = true
  } catch (error) {
    console.warn(
      `[GrokSwitch] relay 同步失败（多为该号还没建 Bot）: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const relaunched = running ? await relaunchGrok('[GrokSwitch]') : false

  return {
    status: 'done',
    scope,
    relaunched,
    relaySynced,
    hasBox: readBoxSavedAt(scope) !== undefined,
    imported: cursorAccount !== undefined
  }
}

/**
 * 从 Grok 客户端移除一个号：只删 sand-secrets 里的条目，Cursor 账号库不动。当前激活的号不能删——删了
 * Grok 重开就是未登录状态，先切到别的号再删。Grok 运行且未确认关闭时先返回 needsClose。
 */
export async function removeGrokAccountFromClient(
  scope: string,
  options: { closeGrok?: boolean } = {}
): Promise<GrokRemoveResult> {
  const accounts = await readGrokAccounts()
  if (!accounts.some((account) => account.scope === scope)) {
    throw new Error(`Grok 客户端里没有这个号: ${scope}`)
  }
  if (readActiveGrokAccountScope() === scope) {
    throw new Error('这是 Grok 当前正在用的号，先切到别的号再删')
  }

  const running = await isGrokRunning()
  if (running && !options.closeGrok) {
    return { status: 'needsClose', scope }
  }
  if (running) await quitGrok()

  await removeGrokAccount(scope)
  const relaunched = running ? await relaunchGrok('[GrokRemove]') : false
  return { status: 'done', scope, relaunched }
}

/** 改完盘把客户端拉起来。起不来只记日志：盘上的改动已经成功，用户手动打开 Grok 一样生效。 */
async function relaunchGrok(tag: string): Promise<boolean> {
  try {
    await launchGrok()
    return true
  } catch (error) {
    console.warn(
      `${tag} 重新启动 Grok Bot 失败: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}
