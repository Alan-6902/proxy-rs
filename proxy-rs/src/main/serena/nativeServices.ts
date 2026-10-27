import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  stat,
  realpath,
  symlink,
  writeFile,
  rename
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { SerenaServiceStore } from './serviceStore'
import {
  SERENA_LS_BUSY_CPU,
  SERENA_REGISTRY_BYTES,
  type SerenaInstance,
  type SerenaNativeAction
} from '../../shared/serena'
import {
  SerenaError,
  SerenaInspector,
  parseListeners,
  parseProcesses,
  readBounded,
  type InspectedRuntime,
  type InternalInstance,
  type SerenaProcess
} from './runtimeInspector'

export const NATIVE_SERENA_VERSION = '2.0.0'
const NATIVE_PYTHON_VERSION = '3.13'
const REGISTRY_LIMIT = SERENA_REGISTRY_BYTES
// JDTLS 等语言服务器退出可能超过 10 秒。
const STOP_WAIT_MS = 20_000
const POLL_MS = 400
export const NATIVE_CLI_NAME = 'serena-native.cjs'
export const RESUME_LABEL = 'com.proxy-rs.serena.resume'
const DESIRED_STATE_FILE = 'desired-state.json'
const EXEMPTIONS_FILE = 'exemptions.json'
type DesiredState = 'running' | 'stopped'

export interface NativeService {
  id: string
  root: string
  port: number
  label: string
  directory: string
  home: string
  projectData: string
  executable: string
  certificateFile: string
  plist: string
  url: string
}
interface NativeEntry extends InternalInstance {
  service: NativeService
  loaded: boolean
  jobOwned: boolean
  processes: Map<number, SerenaProcess>
}

export function nativeServiceId(root: string): string {
  return createHash('sha256').update(root).digest('hex')
}
export function nativeService(home: string, root: string, port: number): NativeService {
  const id = nativeServiceId(root)
  const base = join(home, '.local/share/serena-native')
  const directory = join(base, 'services', id)
  return {
    id,
    root,
    port,
    directory,
    label: `com.proxy-rs.serena.${id.slice(0, 16)}`,
    home: join(directory, 'home'),
    projectData: join(directory, 'project'),
    executable: join(base, 'runtime', NATIVE_SERENA_VERSION, 'bin/serena'),
    certificateFile: join(
      base,
      'runtime',
      NATIVE_SERENA_VERSION,
      'lib',
      `python${NATIVE_PYTHON_VERSION}`,
      'site-packages/certifi/cacert.pem'
    ),
    plist: join(directory, 'service.plist'),
    url: `http://127.0.0.1:${port}/mcp`
  }
}
export function nativeArguments(service: NativeService): string[] {
  return [
    service.executable,
    'start-mcp-server',
    '--transport',
    'streamable-http',
    '--host',
    '127.0.0.1',
    '--port',
    String(service.port),
    '--context',
    'ide',
    '--agent-interface',
    'tools',
    '--project',
    service.root,
    '--enable-web-dashboard',
    'false',
    '--log-level',
    'WARNING'
  ]
}

/** Keeps the shell CLI identical to the copy bundled with the App; skipped until the native runtime directory exists. */
export async function installNativeCli(home: string, source: string): Promise<boolean> {
  const base = join(home, '.local/share/serena-native')
  if (!(await stat(base).catch(() => null))?.isDirectory()) return false
  const bundled = await readFile(source)
  const tools = join(base, 'tools')
  const target = join(tools, NATIVE_CLI_NAME)
  const link = join(home, '.local/bin/serena-native')
  if (!(await lstat(link).catch(() => null))) {
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link)
  }
  if ((await readFile(target).catch(() => null))?.equals(bundled)) return false
  await mkdir(tools, { recursive: true, mode: 0o700 })
  const temporary = join(tools, `.${NATIVE_CLI_NAME}-${randomUUID()}`)
  await writeFile(temporary, bundled, { mode: 0o700, flag: 'wx' })
  await rename(temporary, target)
  return true
}

/** Login agent that restarts services left running; uses the App's Electron as Node so it does not depend on a shell Node. */
export async function installResumeAgent(home: string, executable: string): Promise<boolean> {
  const base = join(home, '.local/share/serena-native')
  if (!(await stat(base).catch(() => null))?.isDirectory()) return false
  const xml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${RESUME_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>${xml(join(base, 'tools', NATIVE_CLI_NAME))}</string><string>resume</string></array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(base, 'resume.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(base, 'resume.log'))}</string>
</dict></plist>\n`
  const target = join(home, 'Library/LaunchAgents', `${RESUME_LABEL}.plist`)
  if ((await readFile(target, 'utf8').catch(() => null)) === plist) return false
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${RESUME_LABEL}-${randomUUID()}`)
  await writeFile(temporary, plist, { mode: 0o644, flag: 'wx' })
  await rename(temporary, target)
  return true
}

export class NativeServices {
  private exemptionWrites: Promise<void> = Promise.resolve()
  /** service.id → 语言服务器持续高负载的起始时间；跨快照保留。 */
  private readonly busySince = new Map<string, number>()

  constructor(private readonly inspector: SerenaInspector) {}

  async services(): Promise<NativeService[]> {
    const records = await new SerenaServiceStore(this.inspector.home, NATIVE_SERENA_VERSION).read()
    return records.map(({ root, port }) => nativeService(this.inspector.home, root, port))
  }

  private async validPlist(service: NativeService): Promise<string | null> {
    try {
      try {
        await stat(join(service.directory, 'registration-pending.json'))
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      }
      const source = await readBounded(service.plist, service.directory, REGISTRY_LIMIT)
      const result = await this.inspector.run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        service.plist
      ])
      if (result.code !== 0 || result.timedOut) return null
      const plist = JSON.parse(result.stdout)
      if (
        plist.Label !== service.label ||
        plist.WorkingDirectory !== service.directory ||
        JSON.stringify(plist.ProgramArguments) !== JSON.stringify(nativeArguments(service)) ||
        plist.EnvironmentVariables?.SERENA_HOME !== service.home ||
        plist.EnvironmentVariables?.SSL_CERT_FILE !== service.certificateFile ||
        plist.KeepAlive !== true ||
        plist.StandardOutPath !== join(service.directory, 'stdout.log') ||
        plist.StandardErrorPath !== join(service.directory, 'stderr.log')
      )
        return null
      const executable = await stat(service.executable)
      if (!executable.isFile() || (executable.mode & 0o022) !== 0) return null
      const certificate = await stat(service.certificateFile)
      if (!certificate.isFile() || (certificate.mode & 0o022) !== 0) return null
      const project = await readBounded(
        join(service.projectData, 'project.yml'),
        service.projectData,
        REGISTRY_LIMIT
      )
      const config = await readBounded(
        join(service.home, 'serena_config.yml'),
        service.home,
        REGISTRY_LIMIT
      )
      const settings = parseYaml(config, { maxAliasCount: 10 })
      if (
        settings?.agent_interface !== 'tools' ||
        settings?.web_dashboard_listen_address !== '127.0.0.1' ||
        settings?.project_serena_folder_location !== service.projectData
      )
        return null
      return createHash('sha256').update(source).update(project).update(config).digest('hex')
    } catch {
      return null
    }
  }

  async entries(): Promise<Map<string, NativeEntry>> {
    const entries = new Map<string, NativeEntry>()
    if (this.inspector.platform !== 'darwin') return entries
    const services = await this.services()
    if (!services.length) return entries
    const [ps, sockets] = await Promise.all([
      this.inspector.run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,%cpu=,rss=,command=']),
      this.inspector.run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
    ])
    const processes = new Map(parseProcesses(ps.stdout).map((item) => [item.pid, item]))
    const children = new Map<number, SerenaProcess[]>()
    for (const item of processes.values())
      children.set(item.ppid, [...(children.get(item.ppid) ?? []), item])
    const listeners = parseListeners(sockets.stdout)
    const exemptions = await this.exemptionList()
    for (const service of services) {
      const configHash = await this.validPlist(service)
      const job = await this.inspector.run('/bin/launchctl', [
        'print',
        `gui/${process.getuid!()}/${service.label}`
      ])
      const absent = !job.timedOut && job.code === 113
      const loaded = job.code === 0 && !job.timedOut
      const jobOwned =
        loaded && job.stdout.split('\n').some((line) => line.trim() === `path = ${service.plist}`)
      const pid = Number(job.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null
      const processInfo = pid ? processes.get(pid) : undefined
      const matching = Boolean(
        jobOwned &&
        processInfo &&
        processInfo.command.includes(`${service.executable} start-mcp-server `) &&
        `${processInfo.command} `.includes(` --project ${service.root} `)
      )
      const listening =
        sockets.code === 0 && !sockets.timedOut && pid
          ? (listeners.get(pid) ?? []).includes(`127.0.0.1:${service.port}`)
          : null
      const legacyConflict = [...processes.values()].some(
        (item) =>
          item.pid !== pid &&
          item.command.includes('start-mcp-server') &&
          [` --project ${service.root} `, ` --project=${service.root} `].some((arg) =>
            `${item.command} `.includes(arg)
          )
      )
      let leftover = false
      let stateInvalid = false
      try {
        leftover =
          !loaded &&
          (await this.stopWitness(service)).some(
            (old) => processes.get(old.pid)?.start === old.start
          )
      } catch {
        stateInvalid = true
      }
      try {
        if ((await realpath(service.root)) !== service.root) stateInvalid = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stateInvalid = true
      }
      const blocked =
        !configHash || stateInvalid
          ? 'nativeConfigInvalid'
          : ps.code !== 0 || ps.timedOut || (!loaded && !absent)
            ? 'identityUnverified'
            : leftover
              ? 'nativeStillStopping'
              : loaded && !jobOwned
                ? 'identityUnverified'
                : loaded && pid && !matching
                  ? 'identityUnverified'
                  : legacyConflict
                    ? 'nativeLegacyConflict'
                    : null
      let languageServer: SerenaInstance['languageServer'] = null
      if (matching && pid) {
        const tree: SerenaProcess[] = []
        for (const queue = [...(children.get(pid) ?? [])]; queue.length; ) {
          const item = queue.shift()!
          tree.push(item)
          queue.push(...(children.get(item.pid) ?? []))
        }
        const cpu = Math.round(tree.reduce((sum, item) => sum + item.cpu, 0) * 10) / 10
        if (cpu < SERENA_LS_BUSY_CPU) this.busySince.delete(service.id)
        else if (!this.busySince.has(service.id)) this.busySince.set(service.id, Date.now())
        languageServer = {
          cpu,
          rssKiB: tree.reduce((sum, item) => sum + item.rssKiB, 0),
          busySince: this.busySince.get(service.id) ?? null
        }
      } else this.busySince.delete(service.id)
      const view: SerenaInstance = {
        id: `native:${service.id}`,
        root: service.root,
        binding: matching ? 'registry-process' : 'candidate',
        backend: 'native-http',
        pid,
        started: processInfo?.start ?? null,
        processState: matching ? 'matched' : absent ? 'missing' : 'unknown',
        port: service.port,
        listening,
        cpu: matching ? (processInfo?.cpu ?? null) : null,
        rssKiB: matching ? (processInfo?.rssKiB ?? null) : null,
        languageServer,
        languages: await this.languages(service),
        recordedStatus: absent ? 'stopped' : matching ? 'running' : null,
        exempt: !exemptions.invalid && exemptions.roots.has(service.root),
        native: {
          version: NATIVE_SERENA_VERSION,
          url: service.url,
          label: service.label,
          loaded,
          blocked
        }
      }
      entries.set(view.id, {
        view,
        service,
        loaded,
        jobOwned,
        processes,
        fingerprint: JSON.stringify([
          service,
          configHash,
          loaded,
          jobOwned,
          pid,
          processInfo?.start,
          blocked
        ])
      })
    }
    return entries
  }

  async snapshot(): Promise<InspectedRuntime> {
    const snapshot: InspectedRuntime['snapshot'] = {
      sampledAt: Date.now(),
      version: NATIVE_SERENA_VERSION,
      registrationAvailable: false,
      instances: [],
      registeredRoots: [],
      registrations: [],
      issues: [],
      partial: false
    }
    if (this.inspector.platform !== 'darwin') {
      snapshot.issues.push('unsupported')
      return { snapshot, entries: new Map() }
    }
    try {
      const entries = await this.entries()
      const services = await this.services()
      snapshot.instances = [...entries.values()].map((item) => item.view)
      snapshot.registeredRoots = services.map((item) => item.root)
      snapshot.registrations = await this.inspector.registrations(services, () => {
        snapshot.partial = true
      })
      if (snapshot.registrations.some((item) => !item.matches))
        snapshot.issues.push('configurationOverlap')
      try {
        const runtime = await stat(
          join(
            this.inspector.home,
            '.local/share/serena-native/runtime',
            NATIVE_SERENA_VERSION,
            'bin/serena'
          )
        )
        snapshot.registrationAvailable = runtime.isFile() && (runtime.mode & 0o022) === 0
      } catch {
        /* 未安装固定运行时。 */
      }
      if (snapshot.partial) snapshot.issues.push('sourceUnavailable')
      if ((await this.exemptionList()).invalid) snapshot.issues.push('exemptionListInvalid')
      return { snapshot, entries }
    } catch {
      snapshot.partial = true
      snapshot.issues.push('nativeRegistryInvalid')
      return { snapshot, entries: new Map() }
    }
  }

  /** Starts services whose last explicit action left them running; adopts loaded services that have no record yet. */
  async resume(): Promise<{ started: string[]; failed: Array<{ root: string; error: string }> }> {
    const started: string[] = []
    const failed: Array<{ root: string; error: string }> = []
    for (const entry of (await this.entries()).values()) {
      const desired = await this.desiredState(entry.service)
      if (desired === null && entry.loaded) await this.saveDesiredState(entry.service, 'running')
      if (desired !== 'running' || entry.loaded) continue
      try {
        await this.control(entry.view.id, 'startNative', entry.fingerprint)
        started.push(entry.service.root)
      } catch (error) {
        failed.push({
          root: entry.service.root,
          error: error instanceof SerenaError ? error.code : String(error)
        })
      }
    }
    return { started, failed }
  }

  async controlRoot(root: string, action: SerenaNativeAction): Promise<void> {
    const entry = [...(await this.entries()).values()].find((item) => item.service.root === root)
    if (!entry) throw new SerenaError('notRegistered')
    await this.control(entry.view.id, action, entry.fingerprint)
  }

  async control(id: string, action: SerenaNativeAction, fingerprint: string): Promise<void> {
    if (action === 'unregisterNative') throw new SerenaError('invalidRequest')
    const entry = (await this.entries()).get(id)
    if (!entry || entry.fingerprint !== fingerprint) throw new SerenaError('stateChanged')
    const blocked = entry.view.native?.blocked
    if (blocked && !(action === 'stopNative' && blocked === 'nativeLegacyConflict'))
      throw new SerenaError(blocked)
    if (action === 'startNative' && entry.loaded) throw new SerenaError('stateChanged')
    if (action !== 'startNative' && !entry.loaded) throw new SerenaError('stateChanged')
    const service = entry.service
    if (action !== 'startNative') {
      const descendants = [...entry.processes.values()].filter((process) => {
        let current: SerenaProcess | undefined = process
        const seen = new Set<number>()
        while (current && !seen.has(current.pid)) {
          if (current.pid === entry.view.pid) return true
          seen.add(current.pid)
          current = entry.processes.get(current.ppid)
        }
        return false
      })
      await this.saveStopWitness(service, descendants)
      const result = await this.inspector.run('/bin/launchctl', [
        'bootout',
        `gui/${process.getuid!()}/${service.label}`
      ])
      if (result.code !== 0 || result.timedOut) throw new SerenaError('commandUncertain')
      const deadline = Date.now() + STOP_WAIT_MS
      let alive = true
      while (Date.now() < deadline) {
        const check = await this.inspector.run('/bin/ps', [
          '-axo',
          'pid=,ppid=,lstart=,%cpu=,rss=,command='
        ])
        if (check.code !== 0 || check.timedOut) break
        const remaining = new Map(parseProcesses(check.stdout).map((item) => [item.pid, item]))
        alive = descendants.some((item) => remaining.get(item.pid)?.start === item.start)
        if (!alive) break
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      if (alive) throw new SerenaError('nativeStillStopping')
      await this.saveStopWitness(service, [])
    }
    if (action !== 'stopNative') {
      if ((await realpath(service.root).catch(() => null)) !== service.root)
        throw new SerenaError('invalidProject')
      const listeners = await this.inspector.run('/usr/sbin/lsof', [
        '-nP',
        `-iTCP:${service.port}`,
        '-sTCP:LISTEN',
        '-Fpn'
      ])
      if (listeners.timedOut || ![0, 1].includes(listeners.code) || listeners.stdout.trim())
        throw new SerenaError('nativePortBusy')
      const result = await this.inspector.run('/bin/launchctl', [
        'bootstrap',
        `gui/${process.getuid!()}`,
        service.plist
      ])
      if (result.code !== 0 || result.timedOut) throw new SerenaError('commandFailed')
    }
    await this.saveDesiredState(service, action === 'stopNative' ? 'stopped' : 'running')
  }

  private async desiredState(service: NativeService): Promise<DesiredState | null> {
    try {
      const value = JSON.parse(
        await readBounded(
          join(service.directory, DESIRED_STATE_FILE),
          service.directory,
          REGISTRY_LIMIT
        )
      )?.state
      return value === 'running' || value === 'stopped' ? value : null
    } catch {
      return null
    }
  }

  private async saveDesiredState(service: NativeService, state: DesiredState): Promise<void> {
    const temporary = join(service.directory, `.desired-state-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify({ state }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(service.directory, DESIRED_STATE_FILE))
  }

  private async stopWitness(
    service: NativeService
  ): Promise<Array<{ pid: number; start: string }>> {
    try {
      const value = JSON.parse(
        await readBounded(
          join(service.directory, 'stop-witness.json'),
          service.directory,
          REGISTRY_LIMIT
        )
      )
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            !Number.isSafeInteger(item?.pid) || item.pid <= 0 || typeof item.start !== 'string'
        )
      )
        throw new SerenaError('nativeConfigInvalid')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new SerenaError('nativeConfigInvalid')
    }
  }

  private async saveStopWitness(service: NativeService, processes: SerenaProcess[]): Promise<void> {
    const target = join(service.directory, 'stop-witness.json')
    const temporary = join(service.directory, `.stop-witness-${randomUUID()}.json`)
    await writeFile(
      temporary,
      JSON.stringify(processes.map(({ pid, start }) => ({ pid, start }))),
      { mode: 0o600, flag: 'wx' }
    )
    await rename(temporary, target)
  }

  private exemptionsPath(): string {
    return join(this.inspector.home, '.local/share/serena-native', EXEMPTIONS_FILE)
  }

  private async exemptionList(): Promise<{ roots: Set<string>; invalid: boolean }> {
    const path = this.exemptionsPath()
    try {
      const link = await lstat(path)
      if (link.isSymbolicLink()) return { roots: new Set(), invalid: true }
      const file = await stat(path)
      if (
        !file.isFile() ||
        (file.mode & 0o077) !== 0 ||
        (process.getuid && file.uid !== process.getuid())
      )
        return { roots: new Set(), invalid: true }
      const data = JSON.parse(
        await readBounded(
          path,
          join(this.inspector.home, '.local/share/serena-native'),
          REGISTRY_LIMIT
        )
      )
      if (
        !data ||
        data.schemaVersion !== 1 ||
        !Array.isArray(data.roots) ||
        Object.keys(data).length !== 2
      )
        return { roots: new Set(), invalid: true }
      const roots = new Set<string>()
      for (const root of data.roots) {
        if (
          typeof root !== 'string' ||
          roots.has(root) ||
          (await realpath(root).catch(() => null)) !== root ||
          root === this.inspector.home ||
          root === '/'
        )
          return { roots: new Set(), invalid: true }
        roots.add(root)
      }
      return { roots, invalid: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { roots: new Set(), invalid: false }
      return { roots: new Set(), invalid: true }
    }
  }

  async setExempt(root: string, exempt: boolean): Promise<void> {
    const write = this.exemptionWrites.then(() => this.applyExempt(root, exempt))
    this.exemptionWrites = write.then(
      () => undefined,
      () => undefined
    )
    await write
  }

  private async applyExempt(root: string, exempt: boolean): Promise<void> {
    const current = await this.exemptionList()
    if (current.invalid) throw new SerenaError('exemptionListInvalid')
    if (!(await this.services()).some((item) => item.root === root))
      throw new SerenaError('notRegistered')
    const roots = exempt
      ? current.roots.has(root)
        ? [...current.roots]
        : [...current.roots, root]
      : [...current.roots].filter((item) => item !== root)
    const target = this.exemptionsPath()
    const temporary = join(dirname(target), `.exemptions-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, roots }), {
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporary, target)
  }

  async languages(service: NativeService): Promise<string[]> {
    try {
      const config = parseYaml(
        await readBounded(
          join(service.projectData, 'project.yml'),
          service.projectData,
          REGISTRY_LIMIT
        ),
        { maxAliasCount: 10 }
      )
      return Array.isArray(config?.language_servers)
        ? config.language_servers.filter(
            (value: unknown): value is string =>
              typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
          )
        : []
    } catch {
      return []
    }
  }
}
