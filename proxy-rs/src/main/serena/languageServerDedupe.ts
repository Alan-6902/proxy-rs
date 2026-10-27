import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, readdir, rename, unlink, utimes } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { NativeService } from './nativeServices'

// Node 的 COPYFILE_FICLONE 在 macOS 上会退化成整份复制；cp -c 走 clonefile，克隆失败直接报错。
const CLONE_COMMAND = ['/bin/cp', '-c'] as const
const STATIC_DIRECTORY = ['language_servers', 'static']
// 运行期仍会写入：顶层 lsp 是 JDTLS 共享索引，各语言服务器下的 workspaces 是项目工作区。
const MUTABLE_TOP_LEVEL = new Set(['lsp'])
const MUTABLE_SECOND_LEVEL = new Set(['workspaces'])

export interface DedupeResult {
  files: number
  bytes: number
}

async function installFiles(root: string, path = root): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (path === root && error.code === 'ENOENT') return []
    throw error
  })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = join(path, entry.name)
    const parts = relative(root, absolute).split(sep)
    if (MUTABLE_TOP_LEVEL.has(parts[0]) || MUTABLE_SECOND_LEVEL.has(parts[1])) continue
    if (entry.isDirectory()) files.push(...(await installFiles(root, absolute)))
    else if (entry.isFile()) files.push(relative(root, absolute))
  }
  return files
}

function digest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** 内容相同的语言服务器安装文件改为 APFS 克隆；各服务仍持有独立文件，写入时自动分离。 */
export async function dedupeLanguageServers(services: NativeService[]): Promise<DedupeResult> {
  const copies = new Map<string, string[]>()
  for (const service of [...services].sort((a, b) => a.id.localeCompare(b.id))) {
    const root = join(service.home, ...STATIC_DIRECTORY)
    for (const file of await installFiles(root))
      copies.set(file, [...(copies.get(file) ?? []), join(root, file)])
  }
  const result: DedupeResult = { files: 0, bytes: 0 }
  for (const [source, ...targets] of copies.values()) {
    const sourceInfo = await lstat(source)
    let sourceDigest: string | undefined
    for (const target of targets) {
      const info = await lstat(target)
      if (
        !info.isFile() ||
        !info.size ||
        info.size !== sourceInfo.size ||
        info.ino === sourceInfo.ino
      )
        continue
      sourceDigest ??= await digest(source)
      if ((await digest(target)) !== sourceDigest) continue
      const temporary = join(dirname(target), `.serena-clone-${randomUUID()}`)
      try {
        await promisify(execFile)(CLONE_COMMAND[0], [CLONE_COMMAND[1], source, temporary])
        await chmod(temporary, info.mode & 0o7777)
        await utimes(temporary, info.atime, info.mtime)
        await rename(temporary, target)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      result.files++
      result.bytes += info.size
    }
  }
  return result
}
