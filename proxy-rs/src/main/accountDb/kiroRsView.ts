/**
 * kiro-rs 在 App 里的两个入口：日志页与内嵌的 Admin 页面。
 *
 * - 日志：kiro-rs 的 stdout / stderr 逐行转进 App 日志存储，分类固定为 kiro-rs。
 *   这里去掉终端颜色码和 kiro-rs 自带的时间戳，按原级别（INFO / WARN / ERROR）落库，
 *   这样日志页能按级别筛选，WARN / ERROR 也会着色。
 * - Admin：渲染进程用 <webview> 嵌入 kiro-rs 自带的 /admin 页面。这里负责两件事：
 *   只允许加载本机 kiro-rs 的 /admin（其它地址一律拦下，外链交给系统浏览器），
 *   以及自动写入 Admin Key 免登录——Key 只在主进程里注入，不经过渲染进程。
 */

import { shell, type WebContents } from 'electron'

/** 日志存储里 kiro-rs 的分类名；日志页按它过滤 */
export const KIRO_RS_LOG_CATEGORY = 'kiro-rs'

/** Admin 页面自己存登录状态用的 localStorage 键（kiro-rs-src/admin-ui/src/lib/storage.ts） */
const ADMIN_UI_API_KEY_STORAGE_KEY = 'adminApiKey'

/** 内嵌 Admin 页面使用的独立会话，与 App 自身及登录用的浏览器隔离 */
export const KIRO_ADMIN_PARTITION = 'persist:kiro-rs-admin'

export type KiroRsLogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface ParsedKiroRsLine {
  level: KiroRsLogLevel
  message: string
}

// 终端颜色码（ESC [ ... m）
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g
// kiro-rs 格式（kiro-rs-src/src/common/log_format.rs）：[2026-09-10T09:35:58.332Z] [INFO] [API] 消息
const KIRO_RS_LINE = /^\[[^\]]+\]\s+\[(TRACE|DEBUG|INFO|WARN|ERROR)\]\s?(.*)$/
// 旧版 kiro-rs 的 tracing 默认格式：2026-09-29T03:27:51.335845Z  INFO kiro_rs::kiro::token_manager: 消息
const TRACING_LINE = /^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s?(.*)$/

function toLevel(rawLevel: string): KiroRsLogLevel {
  return rawLevel === 'ERROR' ? 'ERROR' : rawLevel === 'WARN' ? 'WARN' : 'INFO'
}

/**
 * 解析一行 kiro-rs 输出。认不出格式的行（panic、第三方库直接打印）按原样保留，
 * stderr 上的记为 WARN，便于在日志页被注意到。
 */
export function parseKiroRsLine(line: string, stream: 'stdout' | 'stderr'): ParsedKiroRsLine {
  const plain = line.replace(ANSI_PATTERN, '').trimEnd()
  const current = KIRO_RS_LINE.exec(plain)
  if (current) {
    const [, rawLevel, text] = current
    return { level: toLevel(rawLevel), message: text }
  }
  const legacy = TRACING_LINE.exec(plain)
  if (!legacy) {
    return { level: stream === 'stderr' ? 'WARN' : 'INFO', message: plain }
  }
  const [, rawLevel, target, text] = legacy
  // 模块路径去掉包名前缀，kiro_rs::kiro::token_manager → kiro::token_manager
  const shortTarget = target.replace(/^kiro_rs::?/, '') || 'main'
  return { level: toLevel(rawLevel), message: `${shortTarget}: ${text}` }
}

/** 把一行 kiro-rs 输出按原级别写进 App 日志（经 console 拦截器落库） */
export function logKiroRsLine(line: string, stream: 'stdout' | 'stderr'): void {
  const { level, message } = parseKiroRsLine(line, stream)
  if (!message) return
  const text = `[${KIRO_RS_LOG_CATEGORY}] ${message}`
  if (level === 'ERROR') console.error(text)
  else if (level === 'WARN') console.warn(text)
  else console.log(text)
}

/** kiro-rs Admin 页面地址（由 Admin API 基址推出） */
export function adminUiUrlFromApiBase(apiBase: string): string {
  return `${apiBase.replace(/\/api\/admin\/?$/, '')}/admin`
}

/** 只允许本机 kiro-rs 的 /admin 页面及其静态资源 */
export function isAllowedAdminUrl(url: string, adminUiUrl: string): boolean {
  try {
    const target = new URL(url)
    const allowed = new URL(adminUiUrl)
    return (
      target.protocol === allowed.protocol &&
      target.host === allowed.host &&
      (target.pathname === allowed.pathname || target.pathname.startsWith(`${allowed.pathname}/`))
    )
  } catch {
    return false
  }
}

export interface AdminViewDeps {
  /** 当前 Admin 连接信息；kiro-rs 未就绪时为 null */
  resolve: () => { adminUiUrl: string; adminApiKey: string } | null
}

/**
 * 在主窗口上挂 webview 的安全约束与免登录注入。只需调用一次。
 */
export function installAdminWebviewGuards(host: WebContents, deps: AdminViewDeps): void {
  host.on('will-attach-webview', (event, webPreferences, params) => {
    const target = deps.resolve()
    // 只放行本机 kiro-rs 的 Admin 页面，且不给它任何 preload / Node 能力
    if (
      !target ||
      !isAllowedAdminUrl(params.src, target.adminUiUrl) ||
      params.partition !== KIRO_ADMIN_PARTITION
    ) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })

  host.on('did-attach-webview', (_event, guest) => {
    // 新窗口 / 外链一律交给系统浏览器
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    guest.on('will-navigate', (event, url) => {
      const target = deps.resolve()
      if (!target || !isAllowedAdminUrl(url, target.adminUiUrl)) {
        event.preventDefault()
        if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      }
    })
    // 免登录：Admin 页面读 localStorage 里的 Key 判断是否已登录。
    // 与当前配置不一致（首次打开、Key 改过）时写入并刷新一次。
    guest.on('dom-ready', () => {
      const target = deps.resolve()
      if (!target || !isAllowedAdminUrl(guest.getURL(), target.adminUiUrl)) return
      const key = JSON.stringify(target.adminApiKey)
      const storageKey = JSON.stringify(ADMIN_UI_API_KEY_STORAGE_KEY)
      void guest
        .executeJavaScript(
          `(() => { if (localStorage.getItem(${storageKey}) !== ${key}) {` +
            ` localStorage.setItem(${storageKey}, ${key}); location.reload(); } })()`
        )
        .catch(() => undefined)
    })
  })
}
