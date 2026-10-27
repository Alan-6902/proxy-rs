import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SERENA_REGISTRY_BYTES } from '../../shared/serena'
import { readBounded, SerenaError } from './runtimeInspector'

const DATABASE_FILE = 'services.sqlite3'
const DATABASE_SCHEMA_VERSION = 1

export interface StoredService {
  root: string
  port: number
  version: string
}

/** SQLite 保存管理清单；registry.json 保留为各宿主共同使用的准入记录。 */
export class SerenaServiceStore {
  constructor(
    private readonly home: string,
    private readonly version: string
  ) {}

  async read(): Promise<StoredService[]> {
    const base = join(this.home, '.local/share/serena-native')
    const registry = join(base, 'registry.json')
    let text: string
    try {
      const info = await lstat(registry)
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new SerenaError('nativeRegistryInvalid')
      text = await readBounded(registry, base, SERENA_REGISTRY_BYTES)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new SerenaError('nativeRegistryInvalid')
    }
    let data: { schemaVersion: number; services: StoredService[] }
    try {
      data = JSON.parse(text)
    } catch {
      throw new SerenaError('nativeRegistryInvalid')
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.services))
      throw new SerenaError('nativeRegistryInvalid')
    const roots = new Set<string>()
    const ports = new Set<number>()
    for (const item of data.services) {
      if (
        !item ||
        typeof item.root !== 'string' ||
        !isAbsolute(item.root) ||
        normalize(item.root) !== item.root ||
        item.root === this.home ||
        item.root === '/' ||
        roots.has(item.root) ||
        !Number.isInteger(item.port) ||
        item.port < 1024 ||
        item.port > 65535 ||
        ports.has(item.port) ||
        item.version !== this.version
      )
        throw new SerenaError('nativeRegistryInvalid')
      // 项目被删除不等于登记损坏；由管理层逐项清理失效服务。
      roots.add(item.root)
      ports.add(item.port)
    }
    if ((await realpath(base)) !== base) throw new SerenaError('unsafePath')
    const path = join(base, DATABASE_FILE)
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(path)
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new SerenaError('nativeRegistryInvalid')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE')
      const schema = Number(db.prepare('PRAGMA user_version').get()!.user_version)
      if (schema !== 0 && schema !== DATABASE_SCHEMA_VERSION)
        throw new SerenaError('nativeRegistryInvalid')
      db.exec(`
        CREATE TABLE IF NOT EXISTS services (
          root TEXT PRIMARY KEY,
          port INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1024 AND 65535),
          version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_state (digest TEXT NOT NULL);
        PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
      `)
      const digest = createHash('sha256').update(text).digest('hex')
      if (db.prepare('SELECT digest FROM registry_state').get()?.digest !== digest) {
        db.exec('DELETE FROM services; DELETE FROM registry_state')
        const insert = db.prepare('INSERT INTO services (root, port, version) VALUES (?, ?, ?)')
        for (const item of data.services) insert.run(item.root, item.port, item.version)
        db.prepare('INSERT INTO registry_state (digest) VALUES (?)').run(digest)
      }
      const services = db.prepare('SELECT root, port, version FROM services ORDER BY rowid').all()
      db.exec('COMMIT')
      return services as unknown as StoredService[]
    } finally {
      db.close()
    }
  }
}
