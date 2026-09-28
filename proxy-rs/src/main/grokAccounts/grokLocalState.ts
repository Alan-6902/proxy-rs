/**
 * 本机 Grok Bot 客户端的登录态读写，以及切号前后需要的进程控制。
 *
 * Grok Bot（应用内部代号 sand）把账号存在 `sand-secrets.json` 里，凭据本身就是 cursor.sh 的
 * OAuth session token（`iss=authentication.cursor.sh`），跟 Cursor 同源。账号库结构与 Cursor 的
 * state.vscdb 如出一辙：`{ active, accounts[scope] }`，`scope = sha256(jwt.sub)`。改 `active`
 * 再重启客户端就是切号——和本仓库 Cursor 切号「写 state.vscdb + 重启」是同一套路。
 *
 * 与 Cursor 的关键差异在加密：Grok 的每条 token 用它自己的 safeStorage 密钥加密，密钥存在系统
 * 钥匙串「Grok Bot Safe Storage」里，不是 proxy-rs 自己的密钥。所以不能走 Electron 的 safeStorage，
 * 必须复刻 Chromium OSCrypt 方案（macOS：v10 信封 + PBKDF2/AES-128-CBC）。已验证能对现有值逐字节
 * 复现，写进去的账号客户端能正常解密。
 *
 * 切号必须在 Grok Bot 退出后写：客户端把 sand-secrets 读进内存缓存且不监听文件，运行中改盘会在它
 * 退出时被旧值覆盖。
 */

import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeJwtPayload } from '../cursorAccounts/cursorApi'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// 常量：sand-secrets 的字段名与 OSCrypt 参数
// ---------------------------------------------------------------------------

const SAND_SECRETS_FILE = 'sand-secrets.json'
/** sand-secrets 顶层里存账号库的键；它的值是一段 JSON 字符串。 */
const CURSOR_ACCOUNTS_KEY = 'cursor-accounts'

/** 每个账号条目内部的键，沿用客户端自己的命名。 */
const GROK_ACCOUNT_FIELD = {
  accessToken: 'cursor-access-token',
  refreshToken: 'cursor-refresh-token',
  profile: 'cursor-account-profile',
  selectedTeamId: 'cursor-selected-team-id'
} as const

/** 钥匙串里 Grok Bot 的 safeStorage 密钥服务名，按顺序尝试。 */
const GROK_KEYCHAIN_SERVICES = ['Grok Bot Safe Storage', 'Grok Bot'] as const

/** Chromium OSCrypt(macOS) 的固定参数：v10 信封 + PBKDF2(saltysalt,1003)/AES-128-CBC，IV 为 16 个 0x20。 */
const OSCRYPT = {
  versionPrefix: 'v10',
  salt: 'saltysalt',
  iterations: 1003,
  keyLength: 16,
  digest: 'sha1',
  algorithm: 'aes-128-cbc'
} as const
const OSCRYPT_IV = Buffer.alloc(16, 0x20)

/** 优雅退出后最多等这么久，超时再强杀。 */
const GROK_QUIT_TIMEOUT_MS = 15_000
const GROK_QUIT_POLL_INTERVAL_MS = 300
const MACOS_GROK_EXECUTABLE_SUFFIX = '/Grok Bot.app/Contents/MacOS/Grok Bot'
const GROK_APP_NAME = 'Grok Bot'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个已登录的 Grok 账号（token 已解密）。 */
export interface GrokAccount {
  /** sha256(jwt.sub)，账号库的主键，也是 gateway-descriptor 里 box 的键。 */
  scope: string
  email?: string
  name?: string
  accessToken: string
  refreshToken?: string
  selectedTeamId?: number
}

/** 写入/更新一个账号需要的最小字段。 */
export interface GrokImportPayload {
  accessToken: string
  refreshToken?: string
  email?: string
  name?: string
  selectedTeamId?: number
}

/** 账号库反序列化后的形状。 */
interface GrokAccountsRecord {
  active: string | null
  accounts: Record<string, Record<string, string>>
}

// ---------------------------------------------------------------------------
// 加解密（OSCrypt / macOS）
// ---------------------------------------------------------------------------

/** 从钥匙串读出 Grok Bot 的 safeStorage 明文密钥。首次会弹一次授权，点「始终允许」即可。 */
export async function readGrokKeychainPassword(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Grok 本地账号读写目前仅支持 macOS')
  }
  for (const service of GROK_KEYCHAIN_SERVICES) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-w'
      ])
      const value = stdout.trim()
      if (value) return value
    } catch {
      // 换下一个服务名
    }
  }
  throw new Error('无法从钥匙串读取 Grok Bot safeStorage 密钥，请确认 Grok Bot 已登录')
}

/** PBKDF2 派生 OSCrypt 对称密钥。密钥可注入，便于在无钥匙串环境下做单元测试。 */
export function deriveGrokOsCryptKey(keyText: string): Buffer {
  return pbkdf2Sync(keyText, OSCRYPT.salt, OSCRYPT.iterations, OSCRYPT.keyLength, OSCRYPT.digest)
}

/** 解密单条 sand-secrets 值（base64 的 v10 信封）。 */
export function decryptGrokSecret(base64Value: string, key: Buffer): string {
  const encrypted = Buffer.from(base64Value, 'base64')
  if (encrypted.subarray(0, 3).toString('ascii') !== OSCRYPT.versionPrefix) {
    throw new Error('Grok 凭据信封不是 v10，无法解密')
  }
  const decipher = createDecipheriv(OSCRYPT.algorithm, key, OSCRYPT_IV)
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf-8')
}

/** 加密单条值为 sand-secrets 的存储格式（base64 的 v10 信封）。 */
export function encryptGrokSecret(plaintext: string, key: Buffer): string {
  const cipher = createCipheriv(OSCRYPT.algorithm, key, OSCRYPT_IV)
  const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([Buffer.from(OSCRYPT.versionPrefix, 'ascii'), body]).toString('base64')
}

// ---------------------------------------------------------------------------
// scope 与 profile
// ---------------------------------------------------------------------------

/** 账号主键：JWT 的 sub 的 sha256；不是 JWT 时退化为整段 token 的 sha256。 */
export function grokAccountScope(accessToken: string): string {
  const sub = decodeJwtPayload(accessToken)?.sub
  const principal = typeof sub === 'string' && sub ? sub : accessToken
  return createHash('sha256').update(principal).digest('hex')
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** profile 明文是 `{email,name,avatar}` 的 JSON，只取我们关心的字段。 */
function parseGrokProfile(plaintext: string): { email?: string; name?: string } {
  try {
    const parsed: unknown = JSON.parse(plaintext)
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    return { email: readString(record.email), name: readString(record.name) }
  } catch {
    return {}
  }
}

function buildGrokProfile(email?: string, name?: string): string {
  const profile: Record<string, string> = {}
  const normalizedEmail = readString(email)
  const normalizedName = readString(name)
  if (normalizedEmail) profile.email = normalizedEmail
  if (normalizedName) profile.name = normalizedName
  return JSON.stringify(profile)
}

// ---------------------------------------------------------------------------
// 路径与文件
// ---------------------------------------------------------------------------

export function getGrokDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', GROK_APP_NAME)
    case 'win32': {
      const appData = process.env.APPDATA
      if (!appData) throw new Error('无法获取 APPDATA 环境变量')
      return join(appData, GROK_APP_NAME)
    }
    case 'linux':
      return join(homedir(), '.config', GROK_APP_NAME)
    default:
      throw new Error('Grok 本地账号读写仅支持 macOS、Windows 和 Linux')
  }
}

export function getGrokSecretsPath(): string {
  return join(getGrokDataDir(), SAND_SECRETS_FILE)
}

function readSecretsObject(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf-8')
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('sand-secrets.json 结构无效')
  }
  return parsed as Record<string, unknown>
}

/** `cursor-accounts` 在盘上是 JSON 字符串，也兼容极老版本直接存对象。解析失败按空库处理（与客户端一致）。 */
export function parseGrokAccountsField(raw: unknown): GrokAccountsRecord {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { active: null, accounts: {} }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { active: null, accounts: {} }
  }
  const record = value as Record<string, unknown>
  const active = typeof record.active === 'string' ? record.active : null
  const accounts: Record<string, Record<string, string>> = {}
  if (record.accounts && typeof record.accounts === 'object' && !Array.isArray(record.accounts)) {
    for (const [scope, entry] of Object.entries(record.accounts as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        accounts[scope] = entry as Record<string, string>
      }
    }
  }
  return { active, accounts }
}

/** 原子写回：只改 `cursor-accounts`，其余顶层键（machine-id 等）原样保留。 */
function writeSecretsObject(path: string, secrets: Record<string, unknown>): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  const tmpPath = `${path}.proxy-rs.tmp`
  writeFileSync(tmpPath, JSON.stringify(secrets, null, 2), { mode })
  renameSync(tmpPath, path)
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 解密一个账号条目为 GrokAccount；缺 access token 视为无效返回 null。 */
function decryptAccountEntry(
  scope: string,
  entry: Record<string, string>,
  key: Buffer
): GrokAccount | null {
  const encryptedAccess = entry[GROK_ACCOUNT_FIELD.accessToken]
  if (typeof encryptedAccess !== 'string' || !encryptedAccess) return null
  const accessToken = decryptGrokSecret(encryptedAccess, key)
  const encryptedRefresh = entry[GROK_ACCOUNT_FIELD.refreshToken]
  const refreshToken =
    typeof encryptedRefresh === 'string' && encryptedRefresh
      ? decryptGrokSecret(encryptedRefresh, key)
      : undefined
  const encryptedProfile = entry[GROK_ACCOUNT_FIELD.profile]
  const profile =
    typeof encryptedProfile === 'string' && encryptedProfile
      ? parseGrokProfile(decryptGrokSecret(encryptedProfile, key))
      : {}
  const encryptedTeam = entry[GROK_ACCOUNT_FIELD.selectedTeamId]
  const teamRaw =
    typeof encryptedTeam === 'string' && encryptedTeam
      ? Number(decryptGrokSecret(encryptedTeam, key))
      : Number.NaN
  return {
    scope,
    email: profile.email,
    name: profile.name,
    accessToken,
    refreshToken,
    selectedTeamId: Number.isSafeInteger(teamRaw) && teamRaw > 0 ? teamRaw : undefined
  }
}

/**
 * 读本机 Grok Bot 已登录的所有账号（token 已解密）；未登录返回空数组。
 * path / key 可注入，便于测试；缺省时读真实文件、从钥匙串取密钥。
 */
export async function readGrokAccounts(
  path = getGrokSecretsPath(),
  key?: Buffer
): Promise<GrokAccount[]> {
  if (!existsSync(path)) return []
  const resolvedKey = key ?? deriveGrokOsCryptKey(await readGrokKeychainPassword())
  const record = parseGrokAccountsField(readSecretsObject(path)[CURSOR_ACCOUNTS_KEY])
  const accounts: GrokAccount[] = []
  for (const [scope, entry] of Object.entries(record.accounts)) {
    const account = decryptAccountEntry(scope, entry, resolvedKey)
    if (account) accounts.push(account)
  }
  return accounts
}

/** 当前激活账号的 scope；无则 undefined。只读 active 指针，不需要解密。 */
export function readActiveGrokAccountScope(path = getGrokSecretsPath()): string | undefined {
  if (!existsSync(path)) return undefined
  const record = parseGrokAccountsField(readSecretsObject(path)[CURSOR_ACCOUNTS_KEY])
  return record.active ?? undefined
}

// ---------------------------------------------------------------------------
// 写（调用方负责保证 Grok Bot 此时没在运行）
// ---------------------------------------------------------------------------

/** 在账号库对象上就地 upsert 一个账号，返回它的 scope。 */
function upsertIntoRecord(
  record: GrokAccountsRecord,
  payload: GrokImportPayload,
  key: Buffer
): string {
  const scope = grokAccountScope(payload.accessToken)
  const entry: Record<string, string> = { ...(record.accounts[scope] ?? {}) }
  entry[GROK_ACCOUNT_FIELD.accessToken] = encryptGrokSecret(payload.accessToken, key)
  if (payload.refreshToken) {
    entry[GROK_ACCOUNT_FIELD.refreshToken] = encryptGrokSecret(payload.refreshToken, key)
  } else {
    delete entry[GROK_ACCOUNT_FIELD.refreshToken]
  }
  entry[GROK_ACCOUNT_FIELD.profile] = encryptGrokSecret(
    buildGrokProfile(payload.email, payload.name),
    key
  )
  if (payload.selectedTeamId && Number.isSafeInteger(payload.selectedTeamId)) {
    entry[GROK_ACCOUNT_FIELD.selectedTeamId] = encryptGrokSecret(
      String(payload.selectedTeamId),
      key
    )
  } else {
    delete entry[GROK_ACCOUNT_FIELD.selectedTeamId]
  }
  record.accounts[scope] = entry
  return scope
}

/**
 * 把一个账号的凭据写进 sand-secrets.json（新增或覆盖同 scope），不改动 active。
 * 用它先把账号灌进 Grok 的账号库，之后再 setActiveGrokAccount 切过去。
 * key 可注入，便于测试；缺省时从钥匙串取密钥。
 */
export async function upsertGrokAccount(
  payload: GrokImportPayload,
  injectedKey?: Buffer,
  path = getGrokSecretsPath()
): Promise<GrokAccount> {
  if (!existsSync(path)) {
    throw new Error(`sand-secrets.json 不存在，请先启动并登录过一次 Grok Bot: ${path}`)
  }
  const key = injectedKey ?? deriveGrokOsCryptKey(await readGrokKeychainPassword())
  const secrets = readSecretsObject(path)
  const record = parseGrokAccountsField(secrets[CURSOR_ACCOUNTS_KEY])
  const scope = upsertIntoRecord(record, payload, key)
  secrets[CURSOR_ACCOUNTS_KEY] = JSON.stringify(record)
  writeSecretsObject(path, secrets)
  return {
    scope,
    email: readString(payload.email),
    name: readString(payload.name),
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    selectedTeamId: payload.selectedTeamId
  }
}

/** 把 active 指到指定 scope。该 scope 必须已在账号库里。path 可注入，便于测试。 */
export async function setActiveGrokAccount(
  scope: string,
  path = getGrokSecretsPath()
): Promise<void> {
  if (!existsSync(path)) {
    throw new Error(`sand-secrets.json 不存在: ${path}`)
  }
  const secrets = readSecretsObject(path)
  const record = parseGrokAccountsField(secrets[CURSOR_ACCOUNTS_KEY])
  if (!record.accounts[scope]) {
    throw new Error(`Grok 账号库里没有 scope=${scope}，无法激活`)
  }
  record.active = scope
  secrets[CURSOR_ACCOUNTS_KEY] = JSON.stringify(record)
  writeSecretsObject(path, secrets)
}

/** 从账号库删除一个账号；删的是当前 active 时把 active 置空。path 可注入，便于测试。 */
export async function removeGrokAccount(scope: string, path = getGrokSecretsPath()): Promise<void> {
  if (!existsSync(path)) return
  const secrets = readSecretsObject(path)
  const record = parseGrokAccountsField(secrets[CURSOR_ACCOUNTS_KEY])
  if (!record.accounts[scope] && record.active !== scope) return
  delete record.accounts[scope]
  if (record.active === scope) record.active = null
  secrets[CURSOR_ACCOUNTS_KEY] = JSON.stringify(record)
  writeSecretsObject(path, secrets)
}

// ---------------------------------------------------------------------------
// Grok Bot 进程控制
// ---------------------------------------------------------------------------

interface ProcessEntry {
  pid: number
  command: string
}

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

export async function findGrokPids(): Promise<number[]> {
  if (process.platform !== 'darwin') {
    throw new Error('Grok 进程控制目前仅支持 macOS')
  }
  return (await listUnixProcesses())
    .filter((entry) => entry.command.endsWith(MACOS_GROK_EXECUTABLE_SUFFIX))
    .map((entry) => entry.pid)
}

export async function isGrokRunning(): Promise<boolean> {
  return (await findGrokPids()).length > 0
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 先请 Grok Bot 自己退，超时再强杀；返回时保证没有主进程。 */
export async function quitGrok(timeoutMs = GROK_QUIT_TIMEOUT_MS): Promise<void> {
  const pids = await findGrokPids()
  if (pids.length === 0) return
  await execFileAsync('osascript', ['-e', `tell application "${GROK_APP_NAME}" to quit`]).catch(
    () => undefined
  )
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(GROK_QUIT_POLL_INTERVAL_MS)
    if (!(await isGrokRunning())) return
  }
  signalAll(await findGrokPids(), 'SIGKILL')
  await sleep(GROK_QUIT_POLL_INTERVAL_MS)
  if (await isGrokRunning()) {
    throw new Error('Grok Bot 未能退出，请手动关闭后重试')
  }
}

/** 拉起 Grok Bot。 */
export async function launchGrok(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Grok 自动启动目前仅支持 macOS')
  }
  await execFileAsync('open', ['-a', GROK_APP_NAME])
}
