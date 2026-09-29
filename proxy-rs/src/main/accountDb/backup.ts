/**
 * 账号库定时备份（验收 A27）。
 *
 * - 每天一份，文件名带日期；同一天重复触发只保留最新一份
 * - 只保留最近 BACKUP_KEEP 份，多余的移进废纸篓（不直接删除，与仓库删除约定一致）
 * - 备份与库一样含全部凭据，权限 600，目录 700
 *
 * 恢复：停掉 proxy-rs（kiro-rs 随之退出），把备份文件复制成 accounts.sqlite3 再启动。
 * 注意备份里的 refresh token 可能已被后来的轮换作废，恢复后个别账号可能需要重新登录。
 */

import { chmod, mkdir, readdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AccountDb } from './db'

export const BACKUP_DIR_NAME = 'backups'
export const BACKUP_KEEP = 7
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const BACKUP_PREFIX = 'accounts-'
const BACKUP_SUFFIX = '.sqlite3'

export function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR_NAME)
}

function backupFileName(now: Date): string {
  return `${BACKUP_PREFIX}${now.toISOString().slice(0, 10)}${BACKUP_SUFFIX}`
}

export interface BackupResult {
  file: string
  trashed: string[]
}

export async function backupAccountDb(
  db: AccountDb,
  options: { now?: Date; keep?: number; trashDir?: string } = {}
): Promise<BackupResult> {
  const dir = backupDirFor(db.path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, backupFileName(options.now ?? new Date()))
  // 先写临时文件再改名：备份中途失败不会留下半截的"今天的备份"
  const temp = `${file}.partial`
  await db.backupTo(temp)
  await chmod(temp, 0o600)
  await rename(temp, file)

  const keep = options.keep ?? BACKUP_KEEP
  const all = (await readdir(dir))
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort()
  const excess = all.slice(0, Math.max(0, all.length - keep))
  const trashDir = options.trashDir ?? join(homedir(), '.Trash')
  const trashed: string[] = []
  for (const name of excess) {
    const target = join(trashDir, `${basename(name, BACKUP_SUFFIX)}.${Date.now()}${BACKUP_SUFFIX}`)
    await mkdir(trashDir, { recursive: true })
    await rename(join(dir, name), target)
    trashed.push(target)
  }
  return { file, trashed }
}
