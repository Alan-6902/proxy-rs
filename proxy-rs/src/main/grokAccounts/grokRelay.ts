/**
 * Grok Bot box relay 配置：把某个账号的 box 连接写成本机反代能读的 grok-box-relay.json，并探活。
 *
 * Grok 客户端每登录/打开一个号的 box，就把这个 box 的连接（baseUrl + 短期 token + 网络头）加密写进
 * `gateway-descriptor.json` 的 entries[scope]。本机反代（cursor-sand 注入的 relay）读的是
 * `~/Library/Application Support/SandClientModeStream/sand-client-cli/grok-box-relay.json`，
 * 里面就是这套连接的明文。所以「切号后让反代跟着走」= 解出目标 scope 的 descriptor entry，写进
 * relay 配置。加密同 sand-secrets：safeStorage v10，密钥在钥匙串「Grok Bot Safe Storage」。
 *
 * 逻辑移植自 cursor-sand 的 cursor_bot.py（GROK_GATEWAY_DESCRIPTOR_READER / provision_box_relay），
 * 用 TS 重写，复用 grokLocalState 的解密。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetch as undiciFetch } from 'undici'
import type { GrokRelayStatus } from '../../shared/grokAccounts'
import { decryptGrokSecret, deriveGrokOsCryptKey, readGrokKeychainPassword } from './grokLocalState'

/** 反代读取的 relay 转发路径，与注入到 Grok host 的 relay 路由一致。 */
export const BOX_RELAY_PATH = '/sand-stream-relay/aiserver.v1.InferenceService/Stream'
const GATEWAY_DESCRIPTOR_FILE = 'gateway-descriptor.json'
const RELAY_CONFIG_FILE = 'grok-box-relay.json'
const RELAY_CONFIG_DIR = ['SandClientModeStream', 'sand-client-cli']
/** descriptor entry 早于这个时长视为过期（与客户端 zAt=10080 分钟一致，即 7 天）。 */
const DESCRIPTOR_ENTRY_TTL_MS = 10_080 * 60 * 1000
const PROBE_TIMEOUT_MS = 25_000

/** 写进 relay 配置里、发给 box 的 Grok 0.44 客户端标识头。 */
const SAND_CLIENT_HEADERS: Record<string, string> = {
  'x-cursor-client-type': 'sand',
  'x-cursor-client-source': 'sand-desktop',
  'x-cursor-client-version': '0.44.0',
  'x-sand-box-namespace': 'prod'
}

interface BoxConnection {
  baseUrl: string
  token: string
  headers: Record<string, string>
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function getGrokDataDir(): string {
  if (process.platform !== 'darwin') {
    throw new Error('Grok box relay 目前仅支持 macOS')
  }
  return join(homedir(), 'Library', 'Application Support', 'Grok Bot')
}

function getGatewayDescriptorPath(): string {
  return join(getGrokDataDir(), GATEWAY_DESCRIPTOR_FILE)
}

/** 反代读取 relay 配置的固定位置。 */
export function getRelayConfigPath(): string {
  return join(homedir(), 'Library', 'Application Support', ...RELAY_CONFIG_DIR, RELAY_CONFIG_FILE)
}

// ---------------------------------------------------------------------------
// gateway-descriptor
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 读某个 scope 的 box entry 写入时间（毫秒）；没有该 entry 返回 undefined。 */
export function readBoxSavedAt(scope: string): number | undefined {
  const path = getGatewayDescriptorPath()
  if (!existsSync(path)) return undefined
  try {
    const disk: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!disk || typeof disk !== 'object') return undefined
    const entries = (disk as { entries?: unknown }).entries
    if (!entries || typeof entries !== 'object') return undefined
    const entry = (entries as Record<string, unknown>)[scope]
    if (!entry || typeof entry !== 'object') return undefined
    const savedAtMs = (entry as { savedAtMs?: unknown }).savedAtMs
    return typeof savedAtMs === 'number' && Number.isFinite(savedAtMs) ? savedAtMs : undefined
  } catch {
    return undefined
  }
}

/** 列出所有已建 box 的 scope 及其写入时间。 */
export function listBoxScopes(): Map<string, number> {
  const result = new Map<string, number>()
  const path = getGatewayDescriptorPath()
  if (!existsSync(path)) return result
  try {
    const disk: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const entries =
      disk && typeof disk === 'object' ? (disk as { entries?: unknown }).entries : undefined
    if (!entries || typeof entries !== 'object') return result
    for (const [scope, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') {
        const savedAtMs = (entry as { savedAtMs?: unknown }).savedAtMs
        result.set(scope, typeof savedAtMs === 'number' ? savedAtMs : 0)
      }
    }
  } catch {
    // 解析失败按无 box 处理
  }
  return result
}

/** 解出某个 scope 的 box 连接。entry 不存在/过期/字段不全时抛错。 */
function readBoxConnection(scope: string, key: Buffer, descriptorPath: string): BoxConnection {
  const path = descriptorPath
  if (!existsSync(path)) {
    throw new Error('未找到 Grok Bot gateway descriptor，请先在客户端打开该账号的 Bot')
  }
  const disk: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  const entries =
    disk && typeof disk === 'object' ? (disk as { entries?: unknown }).entries : undefined
  const entry =
    entries && typeof entries === 'object' ? (entries as Record<string, unknown>)[scope] : undefined
  if (!entry || typeof entry !== 'object') {
    throw new Error('当前账号还没有对应的 box，请在 Grok Bot 里打开或新建它的 Bot 后重试')
  }
  const encrypted = (entry as { encrypted?: unknown }).encrypted
  const savedAtMs = (entry as { savedAtMs?: unknown }).savedAtMs
  if (typeof encrypted !== 'string' || !encrypted) {
    throw new Error('Grok Bot gateway descriptor entry 缺少加密数据')
  }
  if (typeof savedAtMs === 'number' && Date.now() - savedAtMs > DESCRIPTOR_ENTRY_TTL_MS) {
    throw new Error('该 box 的连接信息已过期，请在 Grok Bot 里重新打开它的 Bot')
  }
  let connection: unknown
  try {
    connection = JSON.parse(decryptGrokSecret(encrypted, key))
  } catch (error) {
    throw new Error(
      `解密 Grok Bot box 连接失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const record = connection as Record<string, unknown>
  const baseUrl = readString(record?.baseUrl)
  const token = readString(record?.token)
  if (!baseUrl || !baseUrl.startsWith('https://') || !token) {
    throw new Error('Grok Bot box 连接缺少 baseUrl 或 token')
  }
  const headers: Record<string, string> = {}
  const rawHeaders = record.headers
  if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string' && value) headers[name] = value
    }
  }
  return { baseUrl, token, headers }
}

// ---------------------------------------------------------------------------
// relay 配置写入
// ---------------------------------------------------------------------------

/** relay 配置里只存 scope 的指纹（sha256 前 16 位），与反代侧的口径一致。 */
export function relayAccountFingerprint(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16)
}

/** 指纹反查完整 scope。relay 只可能指向建过 box 的号，所以候选就是 descriptor 里的 entries。 */
function resolveScopeByFingerprint(fingerprint: string | undefined): string | undefined {
  if (!fingerprint) return undefined
  for (const scope of listBoxScopes().keys()) {
    if (relayAccountFingerprint(scope) === fingerprint) return scope
  }
  return undefined
}

function writeRelayConfig(scope: string, connection: BoxConnection, path: string): void {
  const relayData = {
    version: 1,
    baseUrl: connection.baseUrl,
    token: connection.token,
    headers: connection.headers,
    relayPath: BOX_RELAY_PATH,
    accountFingerprint: relayAccountFingerprint(scope)
  }
  mkdirSync(join(path, '..'), { recursive: true })
  const tmpPath = `${path}.proxy-rs.tmp`
  writeFileSync(tmpPath, JSON.stringify(relayData, null, 2), { mode: 0o600 })
  renameSync(tmpPath, path)
}

export interface SyncRelayOptions {
  /** 注入 OSCrypt 密钥，跳过钥匙串（测试用）。 */
  key?: Buffer
  /** 注入 gateway-descriptor 路径（测试用）。 */
  descriptorPath?: string
  /** 注入 relay 配置输出路径（测试用）。 */
  relayConfigPath?: string
}

/**
 * 把指定账号的 box 连接写进反代的 relay 配置。成功返回，失败抛错（如该号还没建 box）。
 * options 里的 key/路径可注入，便于测试；缺省读真实文件、从钥匙串取密钥。
 */
export async function syncRelayToAccount(
  scope: string,
  options: SyncRelayOptions = {}
): Promise<void> {
  const key = options.key ?? deriveGrokOsCryptKey(await readGrokKeychainPassword())
  const connection = readBoxConnection(
    scope,
    key,
    options.descriptorPath ?? getGatewayDescriptorPath()
  )
  writeRelayConfig(scope, connection, options.relayConfigPath ?? getRelayConfigPath())
}

// ---------------------------------------------------------------------------
// relay 配置读取与探活
// ---------------------------------------------------------------------------

export interface RelayConfigView {
  baseUrl: string
  token: string
  headers: Record<string, string>
  scope?: string
}

/** 读反代的 relay 配置；字段不全返回 null。path 可注入，便于测试。 */
export function readRelayConfig(path = getRelayConfigPath()): RelayConfigView | null {
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const baseUrl = readString(record.baseUrl)
    const token = readString(record.token)
    if (!baseUrl || !baseUrl.startsWith('https://') || !token) return null
    const headers: Record<string, string> = {}
    if (record.headers && typeof record.headers === 'object') {
      for (const [name, val] of Object.entries(record.headers as Record<string, unknown>)) {
        if (typeof val === 'string' && val) headers[name] = val
      }
    }
    return { baseUrl, token, headers, scope: readString(record.accountFingerprint) }
  } catch {
    return null
  }
}

function buildGatewayUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  base.pathname = base.pathname.replace(/\/$/, '') + '/' + path.replace(/^\//, '')
  base.search = ''
  return base.toString()
}

/**
 * Connect 流帧是 5 字节前缀（flags(1) + length(4 BE)）。relay 转发的上游 Stream 一定以 end-stream
 * 帧（flags & 0x02）收尾。普通 200 HTML/JSON 页解析不出这种帧，用它区分「relay 真挂上了」。
 */
export function connectStreamHasEndFrame(body: Buffer): boolean {
  let offset = 0
  let sawEnd = false
  while (offset + 5 <= body.length) {
    const flags = body[offset]
    const length = body.readUInt32BE(offset + 1)
    offset += 5
    if (offset + length > body.length) return false
    if (flags & 0x02) sawEnd = true
    offset += length
  }
  return sawEnd && offset === body.length
}

/** 探活：对 relay 路由发一个空 Connect 帧，看是否拿到转发过来的 Connect 流。 */
export async function probeRelay(configPath?: string): Promise<GrokRelayStatus> {
  const config = readRelayConfig(configPath ?? getRelayConfigPath())
  if (!config) {
    return { configured: false, ready: false, error: 'relay 配置不存在或字段不完整' }
  }
  // 配置里只有指纹；能反查出完整 scope 就给渲染层，好把「relay 指向谁」标到对应卡片上
  return probeConnection(config, resolveScopeByFingerprint(config.scope) ?? config.scope)
}

/**
 * 直接探某个账号的 box（不经过 relay 配置文件）：给这个号的 Box 装路由时，要盯的是它自己的网关，
 * 而 relay 配置可能还指着别的号。key 可注入，轮询时不必每次都读钥匙串。
 */
export async function probeBoxRelay(
  scope: string,
  options: Pick<SyncRelayOptions, 'key' | 'descriptorPath'> = {}
): Promise<GrokRelayStatus> {
  const key = options.key ?? deriveGrokOsCryptKey(await readGrokKeychainPassword())
  const connection = readBoxConnection(
    scope,
    key,
    options.descriptorPath ?? getGatewayDescriptorPath()
  )
  return probeConnection(connection, scope)
}

async function probeConnection(
  connection: BoxConnection,
  scope?: string
): Promise<GrokRelayStatus> {
  const headers: Record<string, string> = {
    ...connection.headers,
    ...SAND_CLIENT_HEADERS,
    Authorization: `Bearer ${connection.token}`,
    'Content-Type': 'application/connect+proto',
    'Connect-Protocol-Version': '1',
    'X-Request-Id': randomUUID()
  }
  try {
    const response = await undiciFetch(buildGatewayUrl(connection.baseUrl, BOX_RELAY_PATH), {
      method: 'POST',
      headers,
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    const contentType = response.headers.get('content-type') ?? ''
    const body = Buffer.from(await response.arrayBuffer())
    const ready =
      response.status === 200 &&
      contentType.toLowerCase().startsWith('application/connect+proto') &&
      connectStreamHasEndFrame(body)
    return { configured: true, ready, scope, lastStatus: response.status }
  } catch (error) {
    return {
      configured: true,
      ready: false,
      scope,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
