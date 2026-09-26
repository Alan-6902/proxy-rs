/**
 * 本机 Cursor 客户端的登录态读写，以及切号前后需要的进程控制。
 *
 * Cursor 把登录态存在 `User/globalStorage/state.vscdb`（SQLite）的 ItemTable 里，
 * 键是 `cursorAuth/*`。读它可以把本机已登录的号导进账号库；改它就是切号。
 * 切号必须在 Cursor 退出后写：Cursor 运行中会把内存里的旧值写回，改了也白改。
 *
 * SQLite 走 Node 内置的 node:sqlite（Electron 38 / Node 22.21 自带），不引原生依赖。
 * 通过 process.getBuiltinModule 取模块，避免打包器把这个新内置模块当第三方包解析。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CursorAccount } from '../../shared/cursorAccounts'
import type { CursorImportPayload } from './accountStore'
import { extractAuthIdFromAccessToken, normalizeCursorSignUpType } from './cursorApi'

const execFileAsync = promisify(execFile)

type SqliteModule = typeof import('node:sqlite')

/** Cursor 客户端在 state.vscdb 里用的键。 */
export const CURSOR_STATE_KEY = {
  accessToken: 'cursorAuth/accessToken',
  refreshToken: 'cursorAuth/refreshToken',
  cachedEmail: 'cursorAuth/cachedEmail',
  authId: 'cursorAuth/authId',
  membershipType: 'cursorAuth/stripeMembershipType',
  subscriptionStatus: 'cursorAuth/stripeSubscriptionStatus',
  signUpType: 'cursorAuth/cachedSignUpType',
  legacyAccessToken: 'cursor.accessToken',
  legacyEmail: 'cursor.email'
} as const

/** 优雅退出后最多等这么久，超时再强杀。 */
const CURSOR_QUIT_TIMEOUT_MS = 15_000
const CURSOR_QUIT_POLL_INTERVAL_MS = 300
/**
 * macOS 主进程可执行文件路径的尾巴。不用 pgrep：macOS 的 pgrep 读不到受保护进程的参数时会整个
 * 跳过该进程，实测 Cursor 主进程对 `pgrep -f` 甚至 `pgrep Cursor` 都不可见，只有 ps 能列出来。
 * Helper 进程的路径在 Frameworks 下，不会误中。
 */
const MACOS_CURSOR_EXECUTABLE_SUFFIX = '/Cursor.app/Contents/MacOS/Cursor'
/** Linux 下 comm 是截断后的进程名，主进程与子进程同名，按名字全匹配即可。 */
const LINUX_CURSOR_PROCESS_NAMES = new Set(['cursor', 'Cursor'])

function loadSqlite(): SqliteModule {
  const mod = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined
  if (!mod?.DatabaseSync) {
    throw new Error('当前运行时不支持 node:sqlite，无法读写 Cursor 本地登录态')
  }
  return mod
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getCursorDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Cursor')
    case 'win32': {
      const appData = process.env.APPDATA
      if (!appData) throw new Error('无法获取 APPDATA 环境变量')
      return join(appData, 'Cursor')
    }
    case 'linux':
      return join(homedir(), '.config', 'Cursor')
    default:
      throw new Error('Cursor 本地账号读写仅支持 macOS、Windows 和 Linux')
  }
}

export function getCursorStateDbPath(): string {
  return join(getCursorDataDir(), 'User', 'globalStorage', 'state.vscdb')
}

// ---------------------------------------------------------------------------
// state.vscdb
// ---------------------------------------------------------------------------

function readItems(dbPath: string, keys: readonly string[]): Map<string, string> {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
    const result = new Map<string, string>()
    for (const key of keys) {
      const row = statement.get(key) as { value?: unknown } | undefined
      const value = typeof row?.value === 'string' ? row.value.trim() : ''
      if (value) result.set(key, value)
    }
    return result
  } finally {
    db.close()
  }
}

/** 读本机 Cursor 当前登录的号；未登录（缺 token 或邮箱）返回 null。 */
export function readLocalCursorAuth(dbPath = getCursorStateDbPath()): CursorImportPayload | null {
  if (!existsSync(dbPath)) return null
  let items: Map<string, string>
  try {
    items = readItems(dbPath, Object.values(CURSOR_STATE_KEY))
  } catch (error) {
    throw new Error(
      `打开 Cursor 本地数据库失败(${dbPath}): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const accessToken = items.get(CURSOR_STATE_KEY.accessToken)
  const email = items.get(CURSOR_STATE_KEY.cachedEmail)
  if (!accessToken || !email) return null

  const refreshToken = items.get(CURSOR_STATE_KEY.refreshToken)
  // 身份以 token 里的 sub 为准：库里的 authId 键可能是上一个号残留的，信它会把"当前使用"判到别的号
  const authId = extractAuthIdFromAccessToken(accessToken) ?? items.get(CURSOR_STATE_KEY.authId)
  const membershipType = items.get(CURSOR_STATE_KEY.membershipType)
  const subscriptionStatus = items.get(CURSOR_STATE_KEY.subscriptionStatus)
  const signUpType = normalizeCursorSignUpType(items.get(CURSOR_STATE_KEY.signUpType))

  const authRaw: Record<string, unknown> = { accessToken, cachedEmail: email }
  if (refreshToken) authRaw.refreshToken = refreshToken
  if (authId) authRaw.authId = authId
  if (membershipType) authRaw.stripeMembershipType = membershipType
  if (subscriptionStatus) authRaw.stripeSubscriptionStatus = subscriptionStatus
  if (signUpType) authRaw.cachedSignUpType = signUpType

  return {
    email,
    authId,
    accessToken,
    refreshToken,
    membershipType,
    subscriptionStatus,
    signUpType,
    authRaw
  }
}

/** 把账号的登录态写进 state.vscdb。调用方负责保证 Cursor 此时没在运行。 */
export function writeLocalCursorAuth(
  account: CursorAccount,
  dbPath = getCursorStateDbPath()
): void {
  if (!existsSync(dbPath)) {
    throw new Error(`Cursor state.vscdb 不存在，请先启动过一次 Cursor: ${dbPath}`)
  }
  const entries: [string, string | undefined][] = [
    [CURSOR_STATE_KEY.accessToken, account.accessToken],
    [CURSOR_STATE_KEY.refreshToken, account.refreshToken],
    [CURSOR_STATE_KEY.cachedEmail, account.email],
    [CURSOR_STATE_KEY.authId, extractAuthIdFromAccessToken(account.accessToken) ?? account.authId],
    [CURSOR_STATE_KEY.membershipType, account.membershipType],
    [CURSOR_STATE_KEY.subscriptionStatus, account.subscriptionStatus],
    [CURSOR_STATE_KEY.legacyAccessToken, account.accessToken],
    [CURSOR_STATE_KEY.legacyEmail, account.email]
  ]

  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(dbPath)
  try {
    const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
    const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')
    db.exec('BEGIN')
    try {
      for (const [key, value] of entries) {
        // 新号没有的字段要删而不是留着：残留的旧 authId 会让"当前使用"指到别的号，
        // 残留的旧 refreshToken 会让 Cursor 在 token 过期后静默刷回上一个号
        if (value) upsert.run(key, value)
        else remove.run(key)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Cursor process control
// ---------------------------------------------------------------------------

interface ProcessEntry {
  pid: number
  command: string
}

/** `ps -axo pid=,comm=`：每行「pid 可执行文件」，macOS 的 comm 是完整路径，Linux 是短名。 */
async function listUnixProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,comm='])
  const entries: ProcessEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    if (Number.isInteger(pid) && pid > 0) entries.push({ pid, command: match[2].trim() })
  }
  return entries
}

export async function findCursorPids(): Promise<number[]> {
  switch (process.platform) {
    case 'darwin':
      return (await listUnixProcesses())
        .filter((entry) => entry.command.endsWith(MACOS_CURSOR_EXECUTABLE_SUFFIX))
        .map((entry) => entry.pid)
    case 'win32': {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI',
        'IMAGENAME eq Cursor.exe',
        '/NH',
        '/FO',
        'CSV'
      ])
      // 每行形如 "Cursor.exe","1234","Console","1","123,456 K"
      return stdout
        .split(/\r?\n/)
        .map((line) => line.match(/^"Cursor\.exe","(\d+)"/i)?.[1])
        .map((pid) => (pid ? Number.parseInt(pid, 10) : Number.NaN))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    }
    case 'linux':
      return (await listUnixProcesses())
        .filter((entry) => LINUX_CURSOR_PROCESS_NAMES.has(entry.command))
        .map((entry) => entry.pid)
    default:
      return []
  }
}

export async function isCursorRunning(): Promise<boolean> {
  return (await findCursorPids()).length > 0
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // 进程可能已经自己退了
    }
  }
}

async function requestGracefulQuit(pids: number[]): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      // AppleScript quit 走应用自己的退出流程，能触发 Cursor 保存窗口与工作区状态
      await execFileAsync('osascript', ['-e', 'tell application "Cursor" to quit'])
      return
    case 'win32':
      await execFileAsync('taskkill', ['/IM', 'Cursor.exe']).catch(() => undefined)
      return
    default:
      signalAll(pids, 'SIGTERM')
  }
}

async function forceKill(pids: number[]): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/F', '/IM', 'Cursor.exe']).catch(() => undefined)
    return
  }
  signalAll(pids, 'SIGKILL')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 先请 Cursor 自己退（能触发它保存状态），超时再强杀；返回时保证没有 Cursor 主进程。 */
export async function quitCursor(timeoutMs = CURSOR_QUIT_TIMEOUT_MS): Promise<void> {
  const pids = await findCursorPids()
  if (pids.length === 0) return
  await requestGracefulQuit(pids)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(CURSOR_QUIT_POLL_INTERVAL_MS)
    if (!(await isCursorRunning())) return
  }
  await forceKill(await findCursorPids())
  await sleep(CURSOR_QUIT_POLL_INTERVAL_MS)
  if (await isCursorRunning()) {
    throw new Error('Cursor 未能退出，请手动关闭后重试')
  }
}

function windowsCursorExecutableCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'))
  }
  if (process.env.ProgramFiles) {
    candidates.push(join(process.env.ProgramFiles, 'Cursor', 'Cursor.exe'))
  }
  return candidates
}

function spawnDetached(command: string, args: string[] = []): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

/** 拉起 Cursor。启动失败只影响体验不影响切号结果，调用方按警告处理。 */
export async function launchCursor(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      await execFileAsync('open', ['-a', 'Cursor'])
      return
    case 'win32': {
      const executable = windowsCursorExecutableCandidates().find((path) => existsSync(path))
      if (!executable) throw new Error('未找到 Cursor.exe，请手动启动 Cursor')
      spawnDetached(executable)
      return
    }
    case 'linux':
      spawnDetached('cursor')
      return
    default:
      throw new Error('当前平台不支持自动启动 Cursor')
  }
}
