import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isMap, isScalar, parseDocument, stringify as yaml } from 'yaml'
import { parse as parseToml, stringify as toml } from 'smol-toml'
import { SERENA_REGISTRY_BYTES } from '../../shared/serena'
import {
  NativeServices,
  NATIVE_SERENA_VERSION,
  nativeArguments,
  nativeService,
  type NativeService
} from './nativeServices'
import {
  configObject,
  parseProcesses,
  readBounded,
  SerenaError,
  SerenaInspector,
  within
} from './runtimeInspector'

const FIRST_PORT = 39101
const LAST_PORT = 39999
const LS_SPECIFIC_SETTINGS = 'ls_specific_settings'
const JAVA_LANGUAGE = 'java'
const LOMBOK_SHOW_GENERATED = 'lombok_show_generated'
// 项目不受信任时 Serena 忽略 project.yml 的 ls_specific_settings，只能放在服务级配置。
// Serena 2.0 默认展示 Lombok 生成方法，会绕过 JDTLS 对生成方法的跳过（eclipse.jdt.ls#2446），
// 字段上千的 @Getter/@Setter 类单个 documentSymbol 就能超时。
const JAVA_LOMBOK_PATH = [LS_SPECIFIC_SETTINGS, JAVA_LANGUAGE, LOMBOK_SHOW_GENERATED]
// 固定 Serena 2.0.0 的 LanguageServerId；升级运行时需同步核对。
const LANGUAGE_KEYS = new Set([
  'ada',
  'al',
  'angular',
  'ansible',
  'astro',
  'bash',
  'bsl',
  'clojure',
  'cpp',
  'cpp_ccls',
  'crystal',
  'csharp',
  'csharp_omnisharp',
  'cue',
  'dart',
  'deno',
  'elixir',
  'elm',
  'erlang',
  'fortran',
  'fsharp',
  'gdscript',
  'gleam',
  'go',
  'groovy',
  'haskell',
  'haxe',
  'hlsl',
  'html',
  'java',
  'json',
  'julia',
  'julia_fatou',
  'kotlin',
  'latex',
  'lean4',
  'lua',
  'lua_emmylua',
  'luau',
  'markdown',
  'matlab',
  'msl',
  'nextflow',
  'nix',
  'ocaml',
  'pascal',
  'perl',
  'php',
  'php_devsense',
  'php_phpactor',
  'php_phantom',
  'powershell',
  'python',
  'python_basedpyright',
  'python_jedi',
  'python_pyrefly',
  'python_ty',
  'qml',
  'r',
  'rego',
  'ruby',
  'ruby_solargraph',
  'rust',
  'scala',
  'scss',
  'solidity',
  'svelte',
  'swift',
  'systemverilog',
  'terraform',
  'toml',
  'typescript',
  'typescript_vts',
  'vue',
  'wolfram',
  'yaml',
  'zig'
])
const MAX_PROJECT_LANGUAGES = 32
const RUNTIME_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const RESTART_THROTTLE_SECONDS = 30
const HOST_JSON_CONFIGS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.kiro/settings/mcp.json',
  '.pi/mcp.json'
]
const CODEX_CONFIG = '.codex/config.toml'
const IGNORED_PATHS = [
  '**/node_modules/**',
  '**/target/**',
  '**/build/**',
  '**/dist/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.gradle/**',
  '**/vendor/**',
  '**/.worktrees/**'
]
interface Change {
  path: string
  before: string | null
  after: string
  hash: string | null
}
export interface RegistrationPlan {
  id: string
  root: string
  port: number
  changes: Change[]
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

async function existing(path: string, boundary: string): Promise<string | null> {
  try {
    return await readBounded(path, boundary, SERENA_REGISTRY_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function validateLanguages(value: string[]): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_PROJECT_LANGUAGES ||
    value.some((item) => typeof item !== 'string' || !LANGUAGE_KEYS.has(item))
  )
    throw new SerenaError('languagesRequired')
  return [...new Set(value)]
}

function projectSettings(
  source: Record<string, unknown>,
  languages: string[]
): Record<string, unknown> {
  // 不复制可执行激活命令、工具扩展或项目范围外的数据目录。
  for (const key of [
    'activation_command',
    'on_activate',
    'on_activate_commands',
    'activation_commands'
  ])
    if (source[key] && (!Array.isArray(source[key]) || source[key].length))
      throw new SerenaError('nativeConfigInvalid')
  const result: Record<string, unknown> = {}
  for (const key of [
    'project_name',
    'encoding',
    'ignore_all_files_in_gitignore',
    'ignored_paths',
    'read_only',
    'read_only_memory_patterns',
    'ignored_memory_patterns',
    'ls_specific_settings',
    'symbol_info_budget',
    'line_ending',
    'ls_priorities'
  ])
    if (source[key] !== undefined) result[key] = source[key]
  result.language_servers = validateLanguages(languages)
  result.agent_interface = 'tools'
  return result
}

/** 保留注释与已有显式值；无需改动时返回 null。 */
function withJavaLombokDefault(text: string): string | null {
  const document = parseDocument(text)
  if (document.errors.length) throw new SerenaError('nativeConfigInvalid')
  if (document.hasIn(JAVA_LOMBOK_PATH)) return null
  for (let depth = 1; depth < JAVA_LOMBOK_PATH.length; depth++) {
    const path = JAVA_LOMBOK_PATH.slice(0, depth)
    const node = document.getIn(path, true)
    if (node === undefined || (isScalar(node) && node.value === null))
      document.setIn(path, document.createNode({}))
    else if (!isMap(node)) throw new SerenaError('nativeConfigInvalid')
  }
  document.setIn(JAVA_LOMBOK_PATH, false)
  return document.toString({ indentSeq: false, lineWidth: 0 })
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function servicePlist(home: string, service: NativeService): string {
  const path = `${join(home, '.cargo/bin')}:${join(home, '.local/bin')}:${RUNTIME_PATH}:${join(home, 'go/bin')}`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(service.label)}</string>
<key>ProgramArguments</key><array>${nativeArguments(service)
    .map((arg) => `<string>${xml(arg)}</string>`)
    .join('')}</array>
<key>WorkingDirectory</key><string>${xml(service.directory)}</string>
<key>EnvironmentVariables</key><dict><key>SERENA_HOME</key><string>${xml(service.home)}</string><key>SSL_CERT_FILE</key><string>${xml(service.certificateFile)}</string><key>PATH</key><string>${xml(path)}</string><key>PYTHONNOUSERSITE</key><string>1</string></dict>
<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>${RESTART_THROTTLE_SECONDS}</integer>
<key>StandardOutPath</key><string>${xml(join(service.directory, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(service.directory, 'stderr.log'))}</string>
</dict></plist>\n`
}

async function replaceFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.serena-${randomUUID()}`)
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function moveToTrash(home: string, path: string, name: string): Promise<void> {
  const trash = join(home, '.Trash')
  await mkdir(trash, { recursive: true })
  await rename(path, join(trash, `${name}-${Date.now()}`))
}

/** Host entries that still point at this service; unreadable or foreign files are left alone. */
async function hostCleanup(
  root: string,
  url: string
): Promise<Array<{ path: string; before: string; after: string | null }>> {
  const changes: Array<{ path: string; before: string; after: string | null }> = []
  for (const name of [...HOST_JSON_CONFIGS, CODEX_CONFIG]) {
    const path = join(root, name)
    const before = await existing(path, root).catch(() => null)
    if (before === null) continue
    const codex = name === CODEX_CONFIG
    const key = codex ? 'mcp_servers' : 'mcpServers'
    let config: Record<string, unknown>
    let servers: Record<string, unknown>
    try {
      config = configObject(codex ? parseToml(before) : JSON.parse(before))
      servers = configObject(config[key] ?? {})
      if (configObject(servers.serena ?? {}).url !== url) continue
    } catch {
      continue
    }
    delete servers.serena
    if (Object.keys(servers).length) config[key] = servers
    else delete config[key]
    const after = !Object.keys(config).length
      ? null
      : codex
        ? toml(config as Parameters<typeof toml>[0])
        : json(config)
    changes.push({ path, before, after })
  }
  return changes
}

export class NativeRegistration {
  private busy = false
  constructor(
    readonly inspector: SerenaInspector,
    readonly native: NativeServices
  ) {}

  async prepare(
    root: string,
    languages: string[],
    requestedPort?: number,
    excludedPaths: string[] = []
  ): Promise<RegistrationPlan> {
    if (this.inspector.platform !== 'darwin') throw new SerenaError('unsupported')
    if ((await realpath(root)) !== root || root === this.inspector.home || root === '/')
      throw new SerenaError('invalidProject')
    const base = join(this.inspector.home, '.local/share/serena-native')
    const services = await this.native.services()
    const registryBefore = await existing(join(base, 'registry.json'), base)
    if (services.some((item) => item.root === root)) throw new SerenaError('alreadyRegistered')
    let port = requestedPort ?? FIRST_PORT
    while (port <= LAST_PORT) {
      if (!services.some((item) => item.port === port)) {
        const sockets = await this.inspector.run('/usr/sbin/lsof', [
          '-nP',
          `-iTCP:${port}`,
          '-sTCP:LISTEN',
          '-Fpn'
        ])
        if (!sockets.timedOut && sockets.code === 1 && !sockets.stdout.trim()) break
        if (sockets.timedOut || ![0, 1].includes(sockets.code))
          throw new SerenaError('sourceUnavailable')
      }
      if (requestedPort) throw new SerenaError('nativePortBusy')
      port++
    }
    if (!Number.isInteger(port) || port < FIRST_PORT || port > LAST_PORT)
      throw new SerenaError('nativePortBusy')
    const service = nativeService(this.inspector.home, root, port)
    if (
      (await existing(join(service.directory, 'registration-pending.json'), service.directory)) !==
      null
    )
      throw new SerenaError('registrationIncomplete')
    const runtime = await lstat(service.executable)
    if (
      !runtime.isFile() ||
      runtime.mode & 0o022 ||
      (process.getuid && runtime.uid !== process.getuid())
    )
      throw new SerenaError('nativeConfigInvalid')
    const certificate = await lstat(service.certificateFile)
    if (!certificate.isFile() || (certificate.mode & 0o022) !== 0)
      throw new SerenaError('nativeConfigInvalid')
    const changes: Change[] = []
    const add = async (
      path: string,
      after: string,
      boundary: string,
      captured?: string | null
    ): Promise<void> => {
      const before = captured === undefined ? await existing(path, boundary) : captured
      changes.push({ path, before, after, hash: before === null ? null : hash(before) })
    }
    const project = projectSettings(await this.inspector.projectConfiguration(root), languages)
    project.project_name ??= basename(root)
    if (
      excludedPaths.some(
        (path) =>
          !path ||
          path.startsWith('/') ||
          path.split('/').some((part) => part === '..' || part === '.') ||
          /[!*?[\]\\]/.test(path)
      )
    )
      throw new SerenaError('unsafePath')
    if (excludedPaths.length)
      project.ignored_paths = [
        ...(Array.isArray(project.ignored_paths) ? project.ignored_paths : []),
        ...excludedPaths.flatMap((path) => [path, `${path}/**`])
      ]
    await add(join(service.projectData, 'project.yml'), yaml(project), service.directory)
    await add(
      join(service.home, 'serena_config.yml'),
      yaml({
        language_backend: 'LSP',
        agent_interface: 'tools',
        web_dashboard: false,
        web_dashboard_open_on_launch: false,
        web_dashboard_interface: 'browser',
        web_dashboard_listen_address: '127.0.0.1',
        web_dashboard_trusted_hosts: ['127.0.0.1', 'localhost'],
        base_modes: ['interactive', 'editing', 'no-memories'],
        default_modes: [],
        tool_timeout: 240,
        ignored_paths: IGNORED_PATHS,
        project_serena_folder_location: service.projectData,
        projects: [root],
        trusted_project_path_patterns: [],
        ...(languages.includes(JAVA_LANGUAGE)
          ? { [LS_SPECIFIC_SETTINGS]: { [JAVA_LANGUAGE]: { [LOMBOK_SHOW_GENERATED]: false } } }
          : {})
      }),
      service.directory
    )
    await add(service.plist, servicePlist(this.inspector.home, service), service.directory)
    for (const name of HOST_JSON_CONFIGS) {
      const target = join(root, name)
      const previous = await existing(target, root)
      const config = configObject(previous === null ? {} : JSON.parse(previous))
      const servers = configObject(config.mcpServers ?? {})
      for (const key of Object.keys(servers))
        if (key === 'serena' || key.startsWith('serena-native-')) delete servers[key]
      servers.serena =
        name === '.mcp.json' ? { type: 'http', url: service.url } : { url: service.url }
      config.mcpServers = servers
      await add(target, json(config), root, previous)
    }
    const target = join(root, CODEX_CONFIG)
    const previous = await existing(target, root)
    const config = configObject(previous === null ? {} : parseToml(previous))
    const servers = configObject(config.mcp_servers ?? {})
    for (const key of Object.keys(servers))
      if (key === 'serena' || key.startsWith('serena-native-')) delete servers[key]
    servers.serena = { url: service.url, startup_timeout_sec: 240 }
    config.mcp_servers = servers
    await add(target, toml(config as Parameters<typeof toml>[0]), root, previous)
    await add(
      join(base, 'registry.json'),
      json({
        schemaVersion: 1,
        services: [
          ...services.map(({ root, port }) => ({ root, port, version: NATIVE_SERENA_VERSION })),
          { root, port, version: NATIVE_SERENA_VERSION }
        ]
      }),
      base,
      registryBefore
    )
    if (Buffer.byteLength(changes.at(-1)!.after) > SERENA_REGISTRY_BYTES)
      throw new SerenaError('nativeRegistryInvalid')
    return { id: randomUUID(), root, port, changes }
  }

  async publish(plan: RegistrationPlan): Promise<void> {
    if (this.busy) throw new SerenaError('busy')
    this.busy = true
    const base = join(this.inspector.home, '.local/share/serena-native')
    const directory = join(base, 'migrations', plan.id)
    const lock = join(base, 'registration.lock')
    let locked = false
    const done: string[] = []
    const service = nativeService(this.inspector.home, plan.root, plan.port)
    const pending = join(service.directory, 'registration-pending.json')
    try {
      await mkdir(base, { recursive: true, mode: 0o700 })
      if ((await realpath(base)) !== base) throw new SerenaError('unsafePath')
      try {
        await mkdir(lock, { mode: 0o700 })
        locked = true
      } catch {
        throw new SerenaError('busy')
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'plan.json'), json(plan), { flag: 'wx', mode: 0o600 })
      const boundary = (target: string): string => (within(base, target) ? base : plan.root)
      for (const change of plan.changes) {
        const before = await existing(change.path, boundary(change.path))
        if ((before === null ? null : hash(before)) !== change.hash)
          throw new SerenaError('stateChanged')
      }
      await mkdir(service.directory, { recursive: true, mode: 0o700 })
      if (!within(base, await realpath(service.directory))) throw new SerenaError('unsafePath')
      await writeFile(pending, json({ migration: plan.id }), { flag: 'wx', mode: 0o600 })
      for (const change of plan.changes) {
        const parent = dirname(change.path)
        await mkdir(parent, { recursive: true, mode: 0o700 })
        if (!within(boundary(change.path), await realpath(parent)))
          throw new SerenaError('unsafePath')
        const before = await existing(change.path, boundary(change.path))
        if ((before === null ? null : hash(before)) !== change.hash)
          throw new SerenaError('stateChanged')
        const temporary = join(parent, `.serena-${plan.id}-${randomUUID()}`)
        await writeFile(temporary, change.after, { mode: 0o600, flag: 'wx' })
        await rename(temporary, change.path)
        done.push(change.path)
        await writeFile(join(directory, 'progress.json'), json({ state: 'publishing', done }), {
          mode: 0o600
        })
      }
      await writeFile(join(directory, 'progress.json'), json({ state: 'completed', done }), {
        mode: 0o600
      })
      await rename(pending, join(directory, 'registration-completed.json'))
      await this.native.services()
    } catch (error) {
      if (done.length) {
        await writeFile(join(directory, 'progress.json'), json({ state: 'incomplete', done }), {
          mode: 0o600
        })
        throw new SerenaError('registrationIncomplete')
      }
      throw error
    } finally {
      if (locked) {
        // 保留锁记录而不永久删除文件；不自动接管其他进程的锁。
        await rename(lock, join(directory, 'released-lock'))
      }
      this.busy = false
    }
  }

  /** Rewrites launchd definitions of registered services; loaded jobs keep old arguments until restarted. */
  async refresh(): Promise<string[]> {
    const services = await this.native.services()
    return this.locked(async (directory) => {
      const changes: Array<{ root: string; path: string; before: string | null; after: string }> =
        []
      for (const service of services) {
        const pending = join(service.directory, 'registration-pending.json')
        if ((await existing(pending, service.directory)) !== null) continue
        const before = await existing(service.plist, service.directory)
        const after = servicePlist(this.inspector.home, service)
        if (before !== after)
          changes.push({ root: service.root, path: service.plist, before, after })
        if ((await this.native.languages(service)).includes(JAVA_LANGUAGE)) {
          const path = join(service.home, 'serena_config.yml')
          const current = await existing(path, service.directory)
          const updated = current === null ? null : withJavaLombokDefault(current)
          if (updated !== null)
            changes.push({ root: service.root, path, before: current, after: updated })
        }
      }
      await writeFile(join(directory, 'refresh.json'), json(changes), { flag: 'wx', mode: 0o600 })
      for (const change of changes) await replaceFile(change.path, change.after)
      return [...new Set(changes.map((change) => change.root))]
    })
  }

  /** Removes a stopped service; reads the raw registry so a vanished root can still be removed. */
  async unregister(root: string, missingOnly = false): Promise<void> {
    const base = join(this.inspector.home, '.local/share/serena-native')
    const registry = join(base, 'registry.json')
    await this.locked(async (directory) => {
      await this.native.services()
      const before = await existing(registry, base)
      if (before === null) throw new SerenaError('notRegistered')
      let data: { schemaVersion: number; services: Array<{ root: string; port: number }> }
      try {
        data = JSON.parse(before)
      } catch {
        throw new SerenaError('nativeRegistryInvalid')
      }
      if (data?.schemaVersion !== 1 || !Array.isArray(data.services))
        throw new SerenaError('nativeRegistryInvalid')
      const entry = data.services.find((item) => item?.root === root)
      if (!entry || !Number.isInteger(entry.port)) throw new SerenaError('notRegistered')
      const service = nativeService(this.inspector.home, root, entry.port)
      const job = await this.inspector.run('/bin/launchctl', [
        'print',
        `gui/${process.getuid!()}/${service.label}`
      ])
      if (!job.timedOut && job.code === 0) throw new SerenaError('nativeRunning')
      if (job.timedOut || job.code !== 113) throw new SerenaError('commandUncertain')
      const ps = await this.inspector.run('/bin/ps', [
        '-axo',
        'pid=,ppid=,lstart=,%cpu=,rss=,command='
      ])
      if (ps.code !== 0 || ps.timedOut) throw new SerenaError('commandUncertain')
      if (
        parseProcesses(ps.stdout).some((item) =>
          [` --project ${root} `, ` --project=${root} `].some((arg) =>
            `${item.command} `.includes(arg)
          )
        )
      )
        throw new SerenaError('nativeStillStopping')
      if (missingOnly) {
        try {
          await lstat(root)
          throw new SerenaError('stateChanged')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const hosts = missingOnly ? [] : await hostCleanup(root, service.url)
      await writeFile(join(directory, 'unregister.json'), json({ root, registry: before, hosts }), {
        flag: 'wx',
        mode: 0o600
      })
      await replaceFile(
        registry,
        json({ ...data, services: data.services.filter((item) => item !== entry) })
      )
      await this.native.services()
      const prefix = `serena-${service.id.slice(0, 16)}`
      for (const host of hosts)
        if (host.after === null)
          await moveToTrash(
            this.inspector.home,
            host.path,
            `${prefix}-${host.path.slice(root.length + 1).replace(/\//g, '_')}`
          )
        else await replaceFile(host.path, host.after)
      try {
        await moveToTrash(this.inspector.home, service.directory, `${prefix}-service`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }

  private async locked<T>(task: (directory: string) => Promise<T>): Promise<T> {
    if (this.busy) throw new SerenaError('busy')
    this.busy = true
    const base = join(this.inspector.home, '.local/share/serena-native')
    const directory = join(base, 'migrations', randomUUID())
    const lock = join(base, 'registration.lock')
    let locked = false
    try {
      try {
        await mkdir(lock, { mode: 0o700 })
        locked = true
      } catch {
        throw new SerenaError('busy')
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return await task(directory)
    } finally {
      if (locked) await rename(lock, join(directory, 'released-lock'))
      this.busy = false
    }
  }
}
