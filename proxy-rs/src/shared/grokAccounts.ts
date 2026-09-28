/**
 * Grok Bot（应用内部代号 sand）账号管理：主进程与渲染层共用的类型与 IPC 通道名。
 *
 * 背景：本机流量都走 Grok 的 box relay，所以只需要切 Grok，不必再切 Cursor。Grok 的账号凭据
 * 存在 `sand-secrets.json`（safeStorage 加密），本质是 cursor.sh 的 OAuth session token，与
 * Cursor 同源。切号 = 改 `active` 指针并重启客户端；切完再把 Cursor 用的 relay 配置
 * （grok-box-relay.json）指向新号的 box，本机反代即无缝续用。
 *
 * 写 sand-secrets 为什么要先退出 Grok：客户端启动时把文件读进内存缓存，之后不再读盘也不监听文件，
 * 而它自己每次写盘（刷新 token、登录登出、切团队）都是拿内存那份整体覆盖回去。运行中写进去的号
 * 它看不见，还会在它下次写盘时被抹掉。所以所有改盘都放在「退出 → 写 → 重开」这一次里做。
 */

import type { CursorBotUsage, CursorPlanTone } from './cursorAccounts'

export const GROK_ACCOUNTS_CHANNEL = {
  list: 'grok-accounts-list',
  currentScope: 'grok-accounts-current-scope',
  switch: 'grok-accounts-switch',
  remove: 'grok-accounts-remove',
  syncRelay: 'grok-accounts-sync-relay',
  relayStatus: 'grok-accounts-relay-status',
  ensureRelayRoute: 'grok-accounts-ensure-relay-route',
  relayInstallProgress: 'grok-accounts-relay-install-progress',
  changed: 'grok-accounts-changed'
} as const

/**
 * 切号页上的一张卡片：Grok 客户端里已登录的号，或 Cursor 账号库里还没进 Grok 的号。
 * token 不进渲染层，这里只带展示与切号需要的字段。
 * scope = sha256(jwt.sub)，既是 Grok 账号库主键，也是 gateway-descriptor 里 box 的键。
 */
export interface GrokAccountView {
  scope: string
  email?: string
  name?: string
  /** 是否已经在 Grok 客户端的账号库里。false 表示只在 Cursor 账号库，切换时会顺手写进 Grok。 */
  inGrok: boolean
  /** 该账号是否已经建过 box（gateway-descriptor 里有它的 entry）。没有则切过去后仍需在客户端新建 Bot。 */
  hasBox: boolean
  /** box entry 的写入时间（毫秒），用于展示「多久前活跃过」。 */
  boxSavedAt?: number
  /** 该号在 Cursor 账号库里的订阅与 Bot 额度摘要。直接在 Grok 里登录、账号库里没有的号没有这一项。 */
  cursor?: GrokAccountCursorInfo
}

/**
 * Grok 号对应的 Cursor 账号库条目摘要。两边凭据同源（都是 cursor.sh 的 session token），所以用
 * sha256(jwt.sub) 就能把账号库里的号对到 Grok 的 scope 上；订阅和 Bot 额度都由账号库刷新时拉取，
 * 这里只做只读投影，不再单独请求。
 */
export interface GrokAccountCursorInfo {
  /** 套餐展示名，如 Pro / Pro+ Trial / Ultra / Team。 */
  planName: string
  /** 套餐色调，渲染层据此选徽标配色，与 Cursor 账号卡片一致。 */
  planTone: CursorPlanTone
  /** Stripe 订阅状态原文（active / trialing / past_due …），没拉到过为 undefined。 */
  subscriptionStatus?: string
  /** Bot 周额度；null 表示账号库还没拉到过 Bot 用量。 */
  botUsage: CursorBotUsage | null
  /** 账号库最近一次刷新用量的时间（毫秒）。 */
  usageUpdatedAt?: number
}

/**
 * 切号结果。Grok 在运行且未确认关闭时先返回 needsClose，交给界面二次确认。
 * imported=目标号原本不在 Grok 里，这次切换顺手从 Cursor 账号库写了进去。
 */
export type GrokSwitchResult =
  | {
      status: 'done'
      scope: string
      relaunched: boolean
      relaySynced: boolean
      hasBox: boolean
      imported: boolean
    }
  | { status: 'needsClose'; scope: string }

/** 从 Grok 客户端移除一个号的结果；只动 sand-secrets，Cursor 账号库不受影响。 */
export type GrokRemoveResult =
  | { status: 'done'; scope: string; relaunched: boolean }
  | { status: 'needsClose'; scope: string }

/** relay 探活结果：本机反代当前能否通过 grok-box-relay.json 打到 box。 */
export interface GrokRelayStatus {
  /** relay 配置文件是否存在且字段完整。 */
  configured: boolean
  /** 探针是否拿到有效的 Connect 流（200 + application/connect+proto + 结束帧）。 */
  ready: boolean
  /** relay 当前指向的账号 scope；反查不出完整 scope 时退化为配置里的 16 位指纹。 */
  scope?: string
  /** 探针最近一次的 HTTP 状态码。 */
  lastStatus?: number
  /** 失败时的简述。 */
  error?: string
}

/** 未打补丁的 sand-host 对陌生路径的回应：404/405，或被兜底页接住返回 200 但不是 Connect 流。 */
const RELAY_ROUTE_MISSING_STATUSES: readonly number[] = [404, 405]
/** 路由在、但拒绝了本机保存的 box token。 */
const RELAY_UNAUTHORIZED_STATUSES: readonly number[] = [401, 403]
const HTTP_SERVER_ERROR_MIN = 500

/**
 * 探针对 relay 路由的分级判定。
 *
 * 探针发的是一个空 Connect 帧，能可靠回答的只有「路由在不在」：没装的 sand-host 回 404/405；装了的
 * 由各自的 Bot 临场写成，有的接受空请求并回完整 Connect 流（ready），有的校验 Cursor 真实请求才有的
 * 头/体而拒绝空请求（如 417）——后者路由照样在、Cursor 照样能用，只是探针验证不了端到端，记为
 * installedUnverified，不能当成没就绪。
 */
export type RelayRouteState =
  | 'unconfigured'
  | 'ready'
  | 'installedUnverified'
  | 'missing'
  | 'unauthorized'
  | 'serverError'
  | 'unreachable'

export function classifyRelayStatus(status: GrokRelayStatus): RelayRouteState {
  if (!status.configured) return 'unconfigured'
  if (status.ready) return 'ready'
  const code = status.lastStatus
  if (code === undefined) return 'unreachable'
  if (RELAY_ROUTE_MISSING_STATUSES.includes(code) || code === 200) return 'missing'
  if (RELAY_UNAUTHORIZED_STATUSES.includes(code)) return 'unauthorized'
  if (code >= HTTP_SERVER_ERROR_MIN) return 'serverError'
  return 'installedUnverified'
}

/** 「box 网关通了，但 relay 路由还没装」——需要让该号的 Bot 去打补丁的情形。 */
export function isRelayRouteMissing(status: GrokRelayStatus): boolean {
  return classifyRelayStatus(status) === 'missing'
}

/** 路由已经在 Box 上了（不论探针能否端到端验证）；装路由流程以此判成功。 */
export function isRelayRouteInstalled(status: GrokRelayStatus): boolean {
  const state = classifyRelayStatus(status)
  return state === 'ready' || state === 'installedUnverified'
}

export type GrokRelayInstallPhase = 'probing' | 'resolvingAgent' | 'sending' | 'waiting'

/** 装 relay 路由过程中的阶段播报，主进程经 relayInstallProgress 通道推给渲染层。 */
export interface GrokRelayInstallProgress {
  scope: string
  phase: GrokRelayInstallPhase
  message: string
}

/**
 * 装 relay 路由的结果。ready 且 installed=false 表示路由本来就在、没发指令；timeout 表示指令已发出，
 * 但等满时限探针仍没通——Bot 可能还在改或卡住了，需要去 Grok 里看它回了什么。
 */
export type GrokRelayInstallResult =
  | { status: 'ready'; scope: string; installed: boolean; agentName?: string; elapsedMs: number }
  | {
      status: 'timeout'
      scope: string
      agentName: string
      elapsedMs: number
      lastStatus?: number
      /** Bot 最后一句话的摘要，帮用户判断它卡在哪，不用再去客户端翻。 */
      lastBotMessage?: string
    }
