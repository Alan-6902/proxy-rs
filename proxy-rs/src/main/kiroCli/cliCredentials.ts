/**
 * Kiro CLI 本地凭据（data.sqlite3 的 auth_kv / state 表）读写。
 *
 * 三个入口：
 * - switchKiroCliAccount：把某个账号写成 CLI 当前凭据（切号）
 * - syncRefreshedKiroCliCredentials：账号刷新后，把轮换结果同步给正在用它的 CLI
 * - createKiroCliSocialRenewal：CLI 社交凭据临期时主动续期
 *
 * 口径与 Kiro Account Manager 的 macOS 补丁一致：
 * - 社交登录（Github/Google）只写 kirocli:social:token，provider 写小写（github/google）。
 *   不再复制旧补丁那份「企业登录兼容凭据」（kirocli:odic:token，managed_by 为
 *   kiro-account-manager-social-v2），并清掉它连带写入的 auth.idc.start-url 与 Profile 状态。
 * - IdC（BuilderId / Enterprise）写 kirocli:odic:token 与设备注册记录。
 * - 刷新同步只改 refresh_token 与 CLI 当前凭据相同的那条，刷新别的账号不会覆盖 CLI。
 *
 * 每组写操作都包在一个 BEGIN IMMEDIATE 事务里，失败整体回滚。
 */
import { spawn } from 'child_process'
import { access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export const KIRO_CLI_AUTH_KEY = {
  SOCIAL_TOKEN: 'kirocli:social:token',
  OIDC_TOKEN: 'kirocli:odic:token',
  OIDC_DEVICE_REGISTRATION: 'kirocli:odic:device-registration',
  /** 旧版 CLI 的 token 键，切号时一并清掉 */
  LEGACY_CODEWHISPERER_TOKEN: 'codewhisperer:odic:token'
} as const

const KIRO_CLI_TOKEN_KEYS = [
  KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
  KIRO_CLI_AUTH_KEY.OIDC_TOKEN,
  KIRO_CLI_AUTH_KEY.LEGACY_CODEWHISPERER_TOKEN
] as const

const KIRO_CLI_STATE_KEY = {
  IDC_START_URL: 'auth.idc.start-url',
  PROFILE: 'api.codewhisperer.profile'
} as const

/** 旧兼容补丁写进企业兼容副本的 managed_by 标记 */
export const LEGACY_SOCIAL_V2_MARKER = 'kiro-account-manager-social-v2'
/** 旧兼容补丁写进 state 表 auth.idc.start-url 的地址 */
export const LEGACY_SOCIAL_V2_START_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev'

export const KIRO_CLI_RENEWAL_INTERVAL_MS = 60 * 1000
/** CLI 社交凭据剩余有效期不超过该值时续期 */
export const KIRO_CLI_RENEWAL_LEAD_MS = 10 * 60 * 1000

const DEFAULT_TOKEN_TTL_SECONDS = 3600
/** 等 kiro-cli 释放数据库锁的最长时间 */
const SQLITE_BUSY_TIMEOUT_MS = 10_000
/** sqlite3 子进程整体超时，略大于锁等待 */
const SQLITE_PROCESS_TIMEOUT_MS = 15_000
const SQLITE_BIN = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3'

export const KIRO_CLI_SOCIAL_PROVIDERS = ['Github', 'Google'] as const
export type KiroCliSocialProvider = (typeof KIRO_CLI_SOCIAL_PROVIDERS)[number]

/** CLI 里 kirocli:social:token 的内容（只列用到的字段） */
export interface KiroCliSocialToken {
  access_token?: string
  refresh_token: string
  expires_at?: string
  region?: string
  provider?: string
  profile_arn?: string
}

export interface KiroCliRefreshedCredentials {
  accessToken: string
  /** 为空表示服务端没轮换 refresh token，沿用旧值 */
  refreshToken?: string
  expiresIn?: number
}

export interface KiroCliSwitchInput {
  accessToken: string
  refreshToken: string
  /** ISO 时间 */
  expiresAt: string
  region: string
  profileArn?: string
  /** 社交登录的 provider；为空表示 IdC（BuilderId / Enterprise） */
  socialProvider?: KiroCliSocialProvider
  /** IdC 必填 */
  clientId?: string
  /** IdC 必填 */
  clientSecret?: string
}

/** Kiro CLI 数据目录下的 data.sqlite3，路径与 kiro-cli 自身一致 */
export function resolveKiroCliDbPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  // 联调用：指向临时库即可在不动真实 kiro-cli 登录状态的前提下验证切号与同步
  const override = process.env.KIRO_CLI_DB_PATH?.trim()
  if (override) return override
  const dataDir =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'kiro-cli')
      : platform === 'win32'
        ? join(home, 'AppData', 'Local', 'kiro-cli')
        : join(home, '.local', 'share', 'kiro-cli')
  return join(dataDir, 'data.sqlite3')
}

export async function kiroCliDbExists(dbPath: string): Promise<boolean> {
  try {
    await access(dbPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** SQLite 字符串字面量：单引号加倍 */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 从账号的 provider / idp 里认出社交登录 provider；认不出返回 undefined */
export function resolveKiroCliSocialProvider(
  ...candidates: Array<string | undefined>
): KiroCliSocialProvider | undefined {
  return candidates.find((value): value is KiroCliSocialProvider =>
    (KIRO_CLI_SOCIAL_PROVIDERS as readonly string[]).includes(value ?? '')
  )
}

/** 旧兼容补丁写的 start-url（state 表里存的是 JSON 字符串） */
const LEGACY_START_URL_VALUE = sqlQuote(JSON.stringify(LEGACY_SOCIAL_V2_START_URL))

/** 清理旧兼容补丁写入的 auth.idc.start-url 与关联 Profile；condition 为额外前提 */
function legacyStateCleanupSql(condition?: string): string[] {
  const extra = condition ? ` AND ${condition}` : ''
  return [
    `DELETE FROM state WHERE key = ${sqlQuote(KIRO_CLI_STATE_KEY.PROFILE)} AND EXISTS (SELECT 1 FROM state WHERE key = ${sqlQuote(KIRO_CLI_STATE_KEY.IDC_START_URL)} AND value = ${LEGACY_START_URL_VALUE})${extra};`,
    `DELETE FROM state WHERE key = ${sqlQuote(KIRO_CLI_STATE_KEY.IDC_START_URL)} AND value = ${LEGACY_START_URL_VALUE}${extra};`
  ]
}

/** 切号 SQL：写入目标账号凭据，删掉其它 token 键与旧兼容补丁的残留 */
export function buildKiroCliSwitchSql(input: KiroCliSwitchInput): string {
  const isSocial = input.socialProvider !== undefined
  if (!isSocial && (!input.clientId || !input.clientSecret)) {
    throw new Error('IdC 账号切换 Kiro CLI 需要 clientId 与 clientSecret')
  }
  const tokenKey = isSocial ? KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN : KIRO_CLI_AUTH_KEY.OIDC_TOKEN
  const token: Record<string, string> = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    expires_at: input.expiresAt,
    region: input.region
  }
  // kiro-cli 的社交凭据 provider 是小写
  if (input.socialProvider) token.provider = input.socialProvider.toLowerCase()
  if (input.profileArn) token.profile_arn = input.profileArn

  const registrationKey = sqlQuote(KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION)
  const registrationSql = isSocial
    ? `DELETE FROM auth_kv WHERE key = ${registrationKey};`
    : `INSERT OR REPLACE INTO auth_kv (key, value) VALUES (${registrationKey}, ${sqlQuote(
        JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          region: input.region
        })
      )});`

  return [
    'BEGIN IMMEDIATE;',
    'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
    `INSERT OR REPLACE INTO auth_kv (key, value) VALUES (${sqlQuote(tokenKey)}, ${sqlQuote(JSON.stringify(token))});`,
    registrationSql,
    ...legacyStateCleanupSql(),
    ...KIRO_CLI_TOKEN_KEYS.filter((key) => key !== tokenKey).map(
      (key) => `DELETE FROM auth_kv WHERE key = ${sqlQuote(key)};`
    ),
    'COMMIT;'
  ].join('\n')
}

/**
 * 刷新同步 SQL：
 * 1. 用旧 refresh_token 匹配 CLI 当前凭据，只更新匹配的那条
 * 2. 匹配到的社交凭据 provider 转小写
 * 3. CLI 当前是这个社交账号时，删掉旧兼容补丁的企业副本、设备注册与 Profile 状态
 */
export function buildKiroCliRefreshSyncSql(
  oldRefreshToken: string,
  refreshed: KiroCliRefreshedCredentials,
  now: number = Date.now()
): string {
  const nextRefreshToken = refreshed.refreshToken || oldRefreshToken
  const expiresAt = new Date(
    now + (refreshed.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000
  ).toISOString()
  const socialKey = sqlQuote(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN)
  const next = sqlQuote(nextRefreshToken)
  const cliHoldsThisSocialAccount = `EXISTS (SELECT 1 FROM auth_kv WHERE key = ${socialKey} AND json_extract(value, '$.refresh_token') = ${next})`

  return [
    'BEGIN IMMEDIATE;',
    `UPDATE auth_kv SET value = json_set(value, '$.access_token', ${sqlQuote(refreshed.accessToken)}, '$.refresh_token', ${next}, '$.expires_at', ${sqlQuote(expiresAt)}) WHERE key IN (${socialKey}, ${sqlQuote(KIRO_CLI_AUTH_KEY.OIDC_TOKEN)}) AND json_extract(value, '$.refresh_token') = ${sqlQuote(oldRefreshToken)};`,
    `UPDATE auth_kv SET value = json_set(value, '$.provider', lower(json_extract(value, '$.provider'))) WHERE key = ${socialKey} AND json_extract(value, '$.refresh_token') = ${next} AND json_extract(value, '$.provider') IS NOT NULL;`,
    `DELETE FROM auth_kv WHERE key = ${sqlQuote(KIRO_CLI_AUTH_KEY.OIDC_DEVICE_REGISTRATION)} AND ${cliHoldsThisSocialAccount};`,
    `DELETE FROM auth_kv WHERE key = ${sqlQuote(KIRO_CLI_AUTH_KEY.OIDC_TOKEN)} AND json_extract(value, '$.managed_by') = ${sqlQuote(LEGACY_SOCIAL_V2_MARKER)} AND ${cliHoldsThisSocialAccount};`,
    ...legacyStateCleanupSql(cliHoldsThisSocialAccount),
    'COMMIT;'
  ].join('\n')
}

class SqliteBinaryMissingError extends Error {}

/**
 * 用 sqlite3 命令行执行 SQL（异步子进程，不阻塞主进程）。
 * 错误只取 stderr 首行：sqlite3 会在后续行回显出错语句，里面可能带 token。
 */
function runSqlite3(dbPath: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const child = spawn(
      SQLITE_BIN,
      ['-bail', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, dbPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    const timer = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error(`sqlite3 执行超时（${SQLITE_PROCESS_TIMEOUT_MS}ms）`)))
    }, SQLITE_PROCESS_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stdin.on('error', () => {
      // 子进程没起来时写 stdin 会 EPIPE，真正的错误由 'error' / 'close' 上报
    })
    child.on('error', (error: NodeJS.ErrnoException) =>
      settle(() =>
        reject(error.code === 'ENOENT' ? new SqliteBinaryMissingError(error.message) : error)
      )
    )
    child.on('close', (code) =>
      settle(() =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`sqlite3 退出码 ${code}：${stderr.trim().split('\n')[0] ?? ''}`))
      )
    )
    child.stdin.end(sql)
  })
}

async function openNodeSqlite(
  dbPath: string,
  readOnly: boolean
): Promise<import('node:sqlite').DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(dbPath, { readOnly, timeout: SQLITE_BUSY_TIMEOUT_MS })
}

/** 执行写 SQL；没有 sqlite3 命令（常见于 Windows）时退回 Node 内置 SQLite */
async function execKiroCliSql(dbPath: string, sql: string): Promise<void> {
  try {
    await runSqlite3(dbPath, sql)
    return
  } catch (error) {
    if (!(error instanceof SqliteBinaryMissingError)) throw error
  }
  const db = await openNodeSqlite(dbPath, false)
  try {
    db.exec(sql)
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;')
    throw error
  } finally {
    db.close()
  }
}

async function readKiroCliAuthValue(dbPath: string, key: string): Promise<string | null> {
  try {
    const output = await runSqlite3(
      dbPath,
      `SELECT value FROM auth_kv WHERE key = ${sqlQuote(key)};`
    )
    return output.trim() || null
  } catch (error) {
    if (!(error instanceof SqliteBinaryMissingError)) throw error
  }
  const db = await openNodeSqlite(dbPath, true)
  try {
    const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
      | { value?: unknown }
      | undefined
    return typeof row?.value === 'string' && row.value ? row.value : null
  } finally {
    db.close()
  }
}

/** 读 CLI 当前社交凭据；数据库不存在、没有社交凭据或内容损坏时返回 null */
export async function readKiroCliSocialToken(
  dbPath: string = resolveKiroCliDbPath()
): Promise<KiroCliSocialToken | null> {
  if (!(await kiroCliDbExists(dbPath))) return null
  const raw = await readKiroCliAuthValue(dbPath, KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN)
  if (!raw) return null
  try {
    const token = JSON.parse(raw) as Partial<KiroCliSocialToken>
    return typeof token.refresh_token === 'string' && token.refresh_token
      ? (token as KiroCliSocialToken)
      : null
  } catch {
    return null
  }
}

/** CLI 当前持有的凭据（social 与 IdC 共用；只列同步需要的字段） */
export interface KiroCliCurrentToken {
  /** auth_kv 里的键，用于区分社交与 IdC */
  key: string
  refreshToken: string
  provider?: string
}

/**
 * 读 CLI 当前持有的凭据。社交优先（切号时两者互斥，只会存在一条）。
 *
 * 账号库模式下用它作为"同步前的核对"：CLI 里那份必须还是管理器上次写进去的，
 * 才允许覆盖，否则说明用户在 CLI 里自己登录过别的账号。
 */
export async function readKiroCliCurrentToken(
  dbPath: string = resolveKiroCliDbPath()
): Promise<KiroCliCurrentToken | null> {
  if (!(await kiroCliDbExists(dbPath))) return null
  for (const key of [KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, KIRO_CLI_AUTH_KEY.OIDC_TOKEN]) {
    const raw = await readKiroCliAuthValue(dbPath, key)
    if (!raw) continue
    try {
      const token = JSON.parse(raw) as { refresh_token?: unknown; provider?: unknown }
      if (typeof token.refresh_token === 'string' && token.refresh_token) {
        return {
          key,
          refreshToken: token.refresh_token,
          provider: typeof token.provider === 'string' ? token.provider : undefined
        }
      }
    } catch {
      // 内容损坏：当作没有可同步的凭据
    }
  }
  return null
}

/** 切号：数据库必须已由 kiro-cli 建好，不替它建库 */
export async function switchKiroCliAccount(
  input: KiroCliSwitchInput,
  dbPath: string = resolveKiroCliDbPath()
): Promise<void> {
  if (!(await kiroCliDbExists(dbPath))) {
    throw new Error(`未找到 Kiro CLI 数据库（${dbPath}），请先安装并运行一次 kiro-cli`)
  }
  await execKiroCliSql(dbPath, buildKiroCliSwitchSql(input))
}

/** 刷新同步：CLI 没装（数据库不存在）时什么都不做 */
export async function syncRefreshedKiroCliCredentials(
  oldRefreshToken: string,
  refreshed: KiroCliRefreshedCredentials,
  dbPath: string = resolveKiroCliDbPath()
): Promise<void> {
  if (!(await kiroCliDbExists(dbPath))) return
  await execKiroCliSql(dbPath, buildKiroCliRefreshSyncSql(oldRefreshToken, refreshed))
}

export interface KiroCliSocialRenewalOptions {
  /**
   * 续期 CLI 当前社交凭据：在管理器里找 refresh_token 匹配的账号、刷新，
   * 并把结果写回 CLI 与管理器。找不到匹配账号时直接返回。
   */
  renew: (token: KiroCliSocialToken) => Promise<void>
  readToken?: () => Promise<KiroCliSocialToken | null>
  now?: () => number
  intervalMs?: number
  leadMs?: number
  logger?: Pick<Console, 'warn'>
}

export interface KiroCliSocialRenewal {
  /** 检查一次；上一次还没跑完时直接返回，防止重叠 */
  tick: () => Promise<void>
  start: () => void
  stop: () => void
}

/** 每分钟检查 CLI 社交凭据，剩余有效期不超过 leadMs 时调用 renew */
export function createKiroCliSocialRenewal(
  options: KiroCliSocialRenewalOptions
): KiroCliSocialRenewal {
  const readToken = options.readToken ?? (() => readKiroCliSocialToken())
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? KIRO_CLI_RENEWAL_INTERVAL_MS
  const leadMs = options.leadMs ?? KIRO_CLI_RENEWAL_LEAD_MS
  const logger = options.logger ?? console
  let busy = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const token = await readToken()
      if (!token) return
      // expires_at 缺失或无法解析时按已临期处理
      const expiresAt = Date.parse(token.expires_at ?? '')
      if (Number.isFinite(expiresAt) && expiresAt - now() > leadMs) return
      await options.renew(token)
    } catch (error) {
      logger.warn(
        '[KiroCLI] 社交凭据续期检查失败:',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      busy = false
    }
  }

  return {
    tick,
    start: () => {
      if (timer) return
      void tick()
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
