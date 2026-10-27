import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parse as parseToml } from 'smol-toml'
import type {
  SerenaInstance,
  SerenaIssue,
  SerenaRegistration,
  SerenaSnapshot
} from '../../shared/serena'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 20_000
const COMMAND_LOCALE = 'en_US.UTF-8'

export class SerenaError extends Error {
  constructor(readonly code: SerenaIssue) {
    super(code)
  }
}

export interface CommandResult {
  stdout: string
  stderr?: string
  code: number
  timedOut: boolean
}
export type SerenaRunner = (file: string, args: string[]) => Promise<CommandResult>
export const runSerenaCommand: SerenaRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_FILE_BYTES,
        env: { ...process.env, LC_ALL: COMMAND_LOCALE, LANG: COMMAND_LOCALE }
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number; killed?: boolean }) | null
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0,
          timedOut: Boolean(failure?.killed)
        })
      }
    )
  })

export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export async function readBounded(
  path: string,
  boundary: string,
  max = MAX_FILE_BYTES
): Promise<string> {
  const canonical = await realpath(path)
  if (!within(boundary, canonical)) throw new SerenaError('unsafePath')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > max) throw new SerenaError('sourceUnavailable')
    const buffer = Buffer.alloc(max + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > max) throw new SerenaError('sourceUnavailable')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

export interface SerenaProcess {
  pid: number
  ppid: number
  start: string
  cpu: number
  rssKiB: number
  command: string
}
export function parseProcesses(text: string): SerenaProcess[] {
  return text.split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+([\d.]+)\s+(\d+)\s+(.+)$/
    )
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            start: match[3].trim().replace(/\s+/g, ' '),
            cpu: Number(match[4]),
            rssKiB: Number(match[5]),
            command: match[6]
          }
        ]
      : []
  })
}
export function parseListeners(text: string): Map<number, string[]> {
  const result = new Map<number, string[]>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    if (pid && line.startsWith('n')) result.set(pid, [...(result.get(pid) ?? []), line.slice(1)])
  }
  return result
}

export interface InternalInstance {
  view: SerenaInstance
  fingerprint: string
}
export interface InspectedRuntime {
  snapshot: SerenaSnapshot
  entries: Map<string, InternalInstance>
}

export function configObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SerenaError('nativeConfigInvalid')
  return value as Record<string, unknown>
}

export class SerenaInspector {
  readonly home: string
  readonly run: SerenaRunner
  readonly platform: string

  constructor(options: { home?: string; platform?: string; run?: SerenaRunner } = {}) {
    this.home = options.home ?? homedir()
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? runSerenaCommand
  }

  async projectConfiguration(root: string): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {}
    for (const name of ['project.yml', 'project.local.yml']) {
      try {
        const value = configObject(
          parseYaml(await readBounded(join(root, '.serena', name), root), { maxAliasCount: 10 }) ??
            {}
        )
        Object.assign(merged, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return merged
  }

  async projectLanguages(root: string): Promise<string[]> {
    const config = await this.projectConfiguration(root)
    const value = config.language_servers ?? config.languages
    return Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(item)
        )
      : []
  }

  async registrations(
    services: Array<{ root: string; url: string }>,
    incomplete: () => void
  ): Promise<SerenaRegistration[]> {
    const paths = [
      ...[
        '.claude.json',
        '.cursor/mcp.json',
        '.codex/config.toml',
        '.claude/mcp-full.json',
        '.agents/mcp.json',
        '.kiro/settings/mcp.json',
        '.pi/agent/mcp.json',
        '.config/mcp/mcp.json',
        '.agents/mcp/mcp.json'
      ].map((name) => ({
        path: join(this.home, name),
        root: this.home,
        url: null as string | null
      })),
      ...services.flatMap(({ root, url }) =>
        [
          '.mcp.json',
          '.cursor/mcp.json',
          '.codex/config.toml',
          '.kiro/settings/mcp.json',
          '.pi/mcp.json'
        ].map((name) => ({ path: join(root, name), root, url }))
      )
    ]
    const result: SerenaRegistration[] = []
    for (const { path, root, url } of paths) {
      try {
        const raw = await readBounded(path, root)
        const config = configObject(path.endsWith('.toml') ? parseToml(raw) : JSON.parse(raw))
        const servers = configObject(config.mcpServers ?? config.mcp_servers ?? {})
        for (const [name, data] of Object.entries(servers)) {
          const value = configObject(data)
          const command = typeof value.command === 'string' ? basename(value.command) : ''
          if (!name.toLowerCase().includes('serena') && !command.startsWith('serena')) continue
          if (value.enabled === false || value.disabled === true) continue
          result.push({
            source: path,
            name: name.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100),
            transport: command ? 'stdio' : typeof value.url === 'string' ? 'http' : 'unknown',
            matches: !command && url !== null && value.url === url
          })
        }
        if (path === join(this.home, '.claude.json')) {
          for (const [project, projectData] of Object.entries(
            configObject(config.projects ?? {})
          )) {
            const expected = services.find((service) => service.root === project)?.url
            for (const [name, data] of Object.entries(
              configObject(configObject(projectData).mcpServers ?? {})
            )) {
              if (!name.toLowerCase().includes('serena')) continue
              const value = configObject(data)
              result.push({
                source: `${path} (${project})`,
                name,
                transport: value.command ? 'stdio' : 'http',
                matches: !value.command && Boolean(expected) && value.url === expected
              })
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete()
      }
    }
    return result
  }
}
