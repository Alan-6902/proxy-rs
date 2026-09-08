/**
 * 从本机 cockpit-tools（jlcodes99/cockpit-tools）的账号库整批导入 Cursor 账号。
 *
 * 它的目录结构：`~/.antigravity_cockpit/cursor_accounts.json` 是明文索引，每个账号的
 * 详情在 `cursor_accounts/<id>.json`，内容是 AES-256-GCM 信封（密钥 base64 存在
 * `secure-account-storage.key`，12 字节 nonce，无 AAD，密文尾部 16 字节是 tag）。
 * 老版本留下的明文详情文件也认。`.bak` 是它删号后的备份，不导。
 */

import { createDecipheriv } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CursorCockpitImportSummary } from '../../shared/cursorAccounts'
import {
  cursorImportPayloadFromRecord,
  upsertCursorAccounts,
  type CursorImportPayload
} from './accountStore'

const COCKPIT_DATA_DIR_NAME = '.antigravity_cockpit'
const COCKPIT_KEY_FILE = 'secure-account-storage.key'
const COCKPIT_INDEX_FILE = 'cursor_accounts.json'
const COCKPIT_ACCOUNTS_DIR = 'cursor_accounts'
const COCKPIT_ENVELOPE_ALGORITHM = 'AES-256-GCM'
const AES_KEY_LENGTH = 32
const GCM_NONCE_LENGTH = 12
const GCM_TAG_LENGTH = 16

type CockpitToolsImportSummary = CursorCockpitImportSummary

export function cockpitToolsDataDir(): string {
  return join(homedir(), COCKPIT_DATA_DIR_NAME)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readKey(dir: string): Promise<Buffer | null> {
  try {
    const raw = await fs.readFile(join(dir, COCKPIT_KEY_FILE), 'utf-8')
    const key = Buffer.from(raw.trim(), 'base64')
    if (key.length !== AES_KEY_LENGTH) throw new Error('账号详情加密密钥长度无效')
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

interface SecureEnvelope {
  algorithm: string
  nonce: string
  ciphertext: string
}

function asEnvelope(value: unknown): SecureEnvelope | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.algorithm === 'string' &&
    typeof record.nonce === 'string' &&
    typeof record.ciphertext === 'string'
  ) {
    return { algorithm: record.algorithm, nonce: record.nonce, ciphertext: record.ciphertext }
  }
  return null
}

/** 解开 cockpit-tools 的 AES-256-GCM 信封，返回明文 JSON 文本。 */
export function decryptCockpitEnvelope(envelope: SecureEnvelope, key: Buffer): string {
  if (envelope.algorithm !== COCKPIT_ENVELOPE_ALGORITHM) {
    throw new Error(`不支持的账号详情加密算法: ${envelope.algorithm}`)
  }
  const nonce = Buffer.from(envelope.nonce.trim(), 'base64')
  if (nonce.length !== GCM_NONCE_LENGTH) throw new Error('账号详情 nonce 长度无效')
  const payload = Buffer.from(envelope.ciphertext.trim(), 'base64')
  if (payload.length <= GCM_TAG_LENGTH) throw new Error('账号详情密文长度无效')
  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_LENGTH)
  const tag = payload.subarray(payload.length - GCM_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

/** 详情文件既可能是加密信封，也可能是老版本的明文账号 JSON。 */
export function parseCockpitAccountFile(
  content: string,
  key: Buffer | null
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content)
  const envelope = asEnvelope(parsed)
  if (!envelope) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('账号详情不是对象')
    }
    return parsed as Record<string, unknown>
  }
  if (!key) throw new Error('账号详情已加密，但找不到 secure-account-storage.key')
  const plaintext: unknown = JSON.parse(decryptCockpitEnvelope(envelope, key))
  if (!plaintext || typeof plaintext !== 'object' || Array.isArray(plaintext)) {
    throw new Error('解密后的账号详情不是对象')
  }
  return plaintext as Record<string, unknown>
}

async function listAccountIds(dir: string): Promise<string[]> {
  const ids = new Set<string>()
  try {
    const index: unknown = JSON.parse(await fs.readFile(join(dir, COCKPIT_INDEX_FILE), 'utf-8'))
    const accounts = (index as { accounts?: unknown })?.accounts
    if (Array.isArray(accounts)) {
      for (const item of accounts) {
        const id = (item as { id?: unknown })?.id
        if (typeof id === 'string' && id.trim()) ids.add(id.trim())
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CockpitImport] 读取索引失败，改按目录扫描: ${errorMessage(error)}`)
    }
  }
  // 索引可能漏号（cockpit-tools 自己也会按目录补扫），目录里的 .json 一并算上
  try {
    for (const entry of await fs.readdir(join(dir, COCKPIT_ACCOUNTS_DIR))) {
      if (entry.endsWith('.json') && !entry.endsWith('.bak')) ids.add(basename(entry, '.json'))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return [...ids].sort()
}

export async function readCockpitToolsCursorAccounts(
  dir = cockpitToolsDataDir()
): Promise<{ payloads: CursorImportPayload[]; skipped: CockpitToolsImportSummary['skipped'] }> {
  const ids = await listAccountIds(dir)
  if (ids.length === 0) {
    throw new Error(`没有在 ${dir} 找到 cockpit-tools 的 Cursor 账号`)
  }
  const key = await readKey(dir)
  const payloads: CursorImportPayload[] = []
  const skipped: CockpitToolsImportSummary['skipped'] = []
  for (const id of ids) {
    const path = join(dir, COCKPIT_ACCOUNTS_DIR, `${id}.json`)
    try {
      const record = parseCockpitAccountFile(await fs.readFile(path, 'utf-8'), key)
      payloads.push(cursorImportPayloadFromRecord(record))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push({ id, error: '索引里有这个号，但详情文件不存在' })
      } else {
        skipped.push({ id, error: errorMessage(error) })
      }
    }
  }
  return { payloads, skipped }
}

/** 整批导入并按身份去重合并进本地账号库；单个号解不开只跳过它。 */
export async function importCursorAccountsFromCockpitTools(): Promise<CockpitToolsImportSummary> {
  const sourceDir = cockpitToolsDataDir()
  const { payloads, skipped } = await readCockpitToolsCursorAccounts(sourceDir)
  const imported = payloads.length > 0 ? await upsertCursorAccounts(payloads) : []
  console.log(
    `[CockpitImport] 导入完成: ${imported.length} 个账号, 跳过 ${skipped.length} 个, 来源 ${sourceDir}`
  )
  return { imported, skipped, sourceDir }
}
