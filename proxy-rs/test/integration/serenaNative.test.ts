import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  readlink,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { DatabaseSync } from 'node:sqlite'
import { SERENA_LS_BUSY_CPU, type SerenaInstance } from '../../src/shared/serena'
import {
  installNativeCli,
  installResumeAgent,
  NativeServices,
  nativeArguments,
  nativeService,
  nativeServiceId,
  type NativeService
} from '../../src/main/serena/nativeServices'
import { SerenaInspector, type CommandResult } from '../../src/main/serena/runtimeInspector'
import { SerenaManagement } from '../../src/main/serena/management'
import { NativeRegistration, servicePlist } from '../../src/main/serena/nativeRegistration'

const START = 'Mon Oct 19 01:00:00 2026'
const result = (stdout = '', code = 0): CommandResult => ({ stdout, code, timedOut: false })
let home: string
let service: NativeService
let loaded: boolean
let portBusy: boolean
let languageServerCpu: number
let native: NativeServices
let manager: SerenaManagement
let run: ReturnType<
  typeof vi.fn<(file: string, args: string[]) => Promise<ReturnType<typeof result>>>
>

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'serena-native-test-')))
  const root = join(home, 'project')
  await mkdir(root)
  service = nativeService(home, root, 39101)
  for (const path of [
    service.home,
    service.projectData,
    join(service.executable, '..'),
    join(service.certificateFile, '..')
  ])
    await mkdir(path, { recursive: true })
  await writeFile(service.executable, 'fixture, never executed')
  await writeFile(service.certificateFile, 'fixture CA, never used for networking')
  await writeFile(service.plist, 'fixture-plist')
  await writeFile(join(service.projectData, 'project.yml'), 'language_servers: [typescript]\n')
  await writeFile(
    join(service.home, 'serena_config.yml'),
    `agent_interface: tools\nweb_dashboard_listen_address: 127.0.0.1\nproject_serena_folder_location: ${service.projectData}\n`
  )
  await writeFile(
    join(home, '.local/share/serena-native/registry.json'),
    JSON.stringify({
      schemaVersion: 1,
      services: [{ root, port: service.port, version: '2.0.0' }]
    }),
    { mode: 0o600 }
  )
  loaded = false
  portBusy = false
  languageServerCpu = 0
  const plist = {
    Label: service.label,
    WorkingDirectory: service.directory,
    ProgramArguments: nativeArguments(service),
    EnvironmentVariables: { SERENA_HOME: service.home, SSL_CERT_FILE: service.certificateFile },
    KeepAlive: true,
    StandardOutPath: join(service.directory, 'stdout.log'),
    StandardErrorPath: join(service.directory, 'stderr.log')
  }
  run = vi.fn(async (file, args) => {
    if (file === '/usr/bin/plutil') return result(JSON.stringify(plist))
    if (file === '/bin/ps')
      return result(
        loaded
          ? `777 1 ${START} 1.0 1000 ${nativeArguments(service).join(' ')}\n888 777 ${START} ${languageServerCpu.toFixed(1)} 200 /usr/bin/node language-server\n999 888 ${START} 5.0 300 /usr/bin/node tsserver\n`
          : ''
      )
    if (file === '/usr/sbin/lsof')
      return loaded || portBusy
        ? result(`p${loaded ? 777 : 999}\nn127.0.0.1:39101\n`)
        : result('', 1)
    if (file === '/bin/launchctl') {
      if (args[0] === 'print')
        return loaded ? result(`path = ${service.plist}\npid = 777\n`) : result('', 113)
      if (args[0] === 'bootstrap') {
        loaded = true
        return result()
      }
      if (args[0] === 'bootout') {
        loaded = false
        return result()
      }
    }
    return result('', 1)
  })
  const inspector = new SerenaInspector({ home, platform: 'darwin', run })
  native = new NativeServices(inspector)
  manager = new SerenaManagement(inspector)
})
afterEach(async () => {
  vi.restoreAllMocks()
  const trash = join(homedir(), '.Trash')
  await mkdir(trash, { recursive: true })
  await rename(home, join(trash, home.split('/').at(-1)!))
})

describe('fixed-project native services', () => {
  it('keys worktrees by complete root, not basename', () => {
    expect(nativeServiceId('/a/project')).not.toBe(nativeServiceId('/b/project'))
  })
  it('tracks sustained load of all language-server descendants across snapshots', async () => {
    loaded = true
    languageServerCpu = SERENA_LS_BUSY_CPU + 10
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const languageServer = async (): Promise<SerenaInstance['languageServer']> =>
      (await native.snapshot()).snapshot.instances[0].languageServer
    expect(await languageServer()).toEqual({
      cpu: SERENA_LS_BUSY_CPU + 15,
      rssKiB: 500,
      busySince: 1_000
    })
    now.mockReturnValue(61_000)
    expect((await languageServer())?.busySince).toBe(1_000)
    languageServerCpu = 0
    expect((await languageServer())?.busySince).toBeNull()
  })
  it('shows an unloaded service without starting or probing it', async () => {
    const view = (await native.snapshot()).snapshot.instances[0]
    expect(view.languageServer).toBeNull()
    expect(view.backend).toBe('native-http')
    expect(view.native).toMatchObject({
      loaded: false,
      blocked: null,
      url: 'http://127.0.0.1:39101/mcp'
    })
    expect(run.mock.calls.some(([, args]) => ['bootstrap', 'bootout'].includes(args[0]))).toBe(
      false
    )
  })
  it('refuses unsafe registry permissions and retains legacy results', async () => {
    await chmod(join(home, '.local/share/serena-native/registry.json'), 0o644)
    const merged = await native.snapshot()
    expect(merged.snapshot.issues).toContain('nativeRegistryInvalid')
    expect(merged.snapshot.partial).toBe(true)
  })
  it('blocks native startup while the old project instance remains', async () => {
    const original = run.getMockImplementation()!
    run.mockImplementation((file, args) =>
      file === '/bin/ps'
        ? Promise.resolve(
            result(
              `999 1 ${START} 0.0 100 /old/serena start-mcp-server --project ${service.root} --port 38001\n`
            )
          )
        : original(file, args)
    )
    await expect(manager.previewNative(`native:${service.id}`, 'startNative')).rejects.toThrow(
      'nativeLegacyConflict'
    )
  })
  it('starts once through launchd without requiring legacy guard', async () => {
    const preview = await manager.previewNative(`native:${service.id}`, 'startNative')
    await manager.execute(preview.id)
    expect(run).toHaveBeenCalledWith('/bin/launchctl', [
      'bootstrap',
      `gui/${process.getuid!()}`,
      service.plist
    ])
    await expect(manager.execute(preview.id)).rejects.toThrow('expiredPreview')
    expect((await manager.snapshot()).snapshot.instances[0]).toMatchObject({
      processState: 'matched',
      listening: true
    })
  })
  it('stops through bootout and verifies descendants have exited', async () => {
    loaded = true
    const preview = await manager.previewNative(`native:${service.id}`, 'stopNative')
    await manager.execute(preview.id)
    expect(run).toHaveBeenCalledWith('/bin/launchctl', [
      'bootout',
      `gui/${process.getuid!()}/${service.label}`
    ])
    expect(loaded).toBe(false)
    expect(run.mock.calls.some(([file]) => file.includes('kill'))).toBe(false)
  })
  it('invalidates the preview when configuration changes', async () => {
    const preview = await manager.previewNative(`native:${service.id}`, 'startNative')
    await writeFile(service.plist, 'changed-plist')
    await expect(manager.execute(preview.id)).rejects.toThrow('stateChanged')
  })
  it('refuses external Dashboard binding or REPL configuration', async () => {
    await writeFile(
      join(service.home, 'serena_config.yml'),
      `agent_interface: repl\nweb_dashboard_listen_address: 0.0.0.0\nproject_serena_folder_location: ${service.projectData}\n`
    )
    await expect(manager.previewNative(`native:${service.id}`, 'startNative')).rejects.toThrow(
      'nativeConfigInvalid'
    )
  })
  it('refuses an occupied fixed port instead of changing the endpoint', async () => {
    const preview = await manager.previewNative(`native:${service.id}`, 'startNative')
    portBusy = true
    await expect(manager.execute(preview.id)).rejects.toThrow('nativePortBusy')
    expect(run.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false)
  })
  it('retains stopping evidence across manager instances', async () => {
    await writeFile(
      join(service.directory, 'stop-witness.json'),
      JSON.stringify([{ pid: 888, start: START }]),
      { mode: 0o600 }
    )
    const original = run.getMockImplementation()!
    run.mockImplementation((file, args) =>
      file === '/bin/ps'
        ? Promise.resolve(result(`888 1 ${START} 0.0 200 /usr/bin/node language-server\n`))
        : original(file, args)
    )
    const restartedManager = new SerenaManagement(manager.inspector)
    await expect(
      restartedManager.previewNative(`native:${service.id}`, 'startNative')
    ).rejects.toThrow('nativeStillStopping')
  })

  it('uses only the native registry for version and registered roots', async () => {
    const { snapshot } = await manager.snapshot()
    expect(snapshot.version).toBe('2.0.0')
    expect(snapshot.registeredRoots).toEqual([service.root])
    expect(snapshot.registrationAvailable).toBe(true)
    expect(snapshot.issues).not.toContain('guardMissing')
    expect(run.mock.calls.some(([file]) => file.includes('guard'))).toBe(false)
  })
  it('accepts 33 entries without dropping the registry', async () => {
    const services: Array<{ root: string; port: number; version: string }> = []
    for (let i = 0; i < 33; i++) {
      const root = join(home, `root-${i}`)
      await mkdir(root)
      services.push({ root, port: 39101 + i, version: '2.0.0' })
    }
    await writeFile(
      join(home, '.local/share/serena-native/registry.json'),
      JSON.stringify({ schemaVersion: 1, services })
    )
    expect(await native.services()).toHaveLength(33)
  })
  it('rejects duplicate ports and oversized registry text', async () => {
    const path = join(home, '.local/share/serena-native/registry.json')
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        services: [
          { root: service.root, port: 39101, version: '2.0.0' },
          { root: service.root, port: 39101, version: '2.0.0' }
        ]
      })
    )
    await expect(native.services()).rejects.toThrow('nativeRegistryInvalid')
    await writeFile(path, ' '.repeat(1024 * 1024 + 1))
    await expect(native.services()).rejects.toThrow('nativeRegistryInvalid')
  })
  it('refuses partially published service configuration', async () => {
    await writeFile(join(service.directory, 'registration-pending.json'), '{}')
    await expect(manager.previewNative(`native:${service.id}`, 'startNative')).rejects.toThrow(
      'nativeConfigInvalid'
    )
  })

  it('keeps a broken stop witness isolated to its own service card', async () => {
    await writeFile(join(service.directory, 'stop-witness.json'), '{broken')
    const { snapshot } = await native.snapshot()
    expect(snapshot.instances).toHaveLength(1)
    expect(snapshot.instances[0].native.blocked).toBe('nativeConfigInvalid')
    expect(snapshot.issues).not.toContain('nativeRegistryInvalid')
    expect(snapshot.registrationAvailable).toBe(true)
  })
  it('rejects a caller-supplied service identifier', async () => {
    await expect(manager.previewNative('native:../../other', 'stopNative')).rejects.toThrow(
      'invalidRequest'
    )
  })
})

describe('native service maintenance', () => {
  const registry = (): string => join(home, '.local/share/serena-native/registry.json')
  const registration = (): NativeRegistration =>
    new NativeRegistration(manager.inspector, manager.native)

  it('launches without the Dashboard and with warning-level logs', () => {
    const args = nativeArguments(service)
    expect(args.slice(args.indexOf('--enable-web-dashboard'))).toEqual([
      '--enable-web-dashboard',
      'false',
      '--log-level',
      'WARNING'
    ])
  })
  it('rewrites stale launch definitions once', async () => {
    expect(await registration().refresh()).toEqual([service.root])
    expect(await readFile(service.plist, 'utf8')).toBe(servicePlist(home, service))
    expect(await registration().refresh()).toEqual([])
  })
  it('backfills the Java Lombok default once and keeps comments and explicit values', async () => {
    const config = join(service.home, 'serena_config.yml')
    await writeFile(service.plist, servicePlist(home, service))
    await writeFile(config, '# keep me\nagent_interface: tools\nls_specific_settings: {}\n')
    expect(await registration().refresh()).toEqual([])
    await writeFile(join(service.projectData, 'project.yml'), 'language_servers: [java]\n')
    expect(await registration().refresh()).toEqual([service.root])
    const text = await readFile(config, 'utf8')
    expect(text).toContain('# keep me')
    expect(parseYaml(text).ls_specific_settings).toEqual({ java: { lombok_show_generated: false } })
    expect(await registration().refresh()).toEqual([])
    await writeFile(config, 'ls_specific_settings:\n  java:\n    lombok_show_generated: true\n')
    expect(await registration().refresh()).toEqual([])
    await writeFile(config, 'ls_specific_settings: [broken]\n')
    await expect(registration().refresh()).rejects.toThrow('nativeConfigInvalid')
  })
  it('refuses to unregister a loaded service', async () => {
    loaded = true
    await expect(registration().unregister(service.root)).rejects.toThrow('nativeRunning')
    expect(JSON.parse(await readFile(registry(), 'utf8')).services).toHaveLength(1)
  })
  it('unregisters a stopped service whose root has vanished', async () => {
    await rename(service.root, join(home, 'moved-project'))
    expect(await native.services()).toEqual([service])
    await registration().unregister(service.root)
    expect(JSON.parse(await readFile(registry(), 'utf8')).services).toEqual([])
    expect(await native.services()).toEqual([])
    await expect(stat(service.directory)).rejects.toThrow()
    expect((await readdir(join(home, '.Trash')))[0]).toMatch(/^serena-[0-9a-f]{16}-service-/)
  })
  it('automatically removes a vanished project while keeping healthy services usable', async () => {
    const missingRoot = join(home, 'deleted-project')
    await writeFile(
      registry(),
      JSON.stringify({
        schemaVersion: 1,
        services: [
          { root: service.root, port: service.port, version: '2.0.0' },
          { root: missingRoot, port: service.port + 1, version: '2.0.0' }
        ]
      })
    )
    const { snapshot } = await manager.snapshot()
    expect(snapshot.registeredRoots).toEqual([service.root])
    expect(snapshot.instances).toHaveLength(1)
    expect(snapshot.issues).not.toContain('nativeRegistryInvalid')
    expect(JSON.parse(await readFile(registry(), 'utf8')).services).toHaveLength(1)
    await expect(
      manager.previewNative(`native:${service.id}`, 'startNative')
    ).resolves.toMatchObject({
      root: service.root
    })
  })
  it('stops an owned service before automatically removing its vanished project', async () => {
    loaded = true
    await rename(service.root, join(home, 'moved-project'))
    const { snapshot } = await manager.snapshot()
    expect(snapshot.registeredRoots).toEqual([])
    expect(snapshot.issues).not.toContain('nativeRegistryInvalid')
    expect(loaded).toBe(false)
    expect(run).toHaveBeenCalledWith('/bin/launchctl', [
      'bootout',
      `gui/${process.getuid!()}/${service.label}`
    ])
  })
  it('isolates cleanup failures and retries them on a later snapshot', async () => {
    const original = run.getMockImplementation()!
    await rename(service.root, join(home, 'moved-project'))
    run.mockImplementation((file, args) =>
      file === '/bin/launchctl' && args[0] === 'print'
        ? Promise.resolve(result('', 1))
        : original(file, args)
    )
    const { snapshot } = await manager.snapshot()
    expect(snapshot.instances).toHaveLength(1)
    expect(snapshot.issues).toContain('sourceUnavailable')
    expect(snapshot.issues).not.toContain('nativeRegistryInvalid')
    expect(JSON.parse(await readFile(registry(), 'utf8')).services).toHaveLength(1)
    run.mockImplementation(original)
    expect((await manager.snapshot()).snapshot.instances).toEqual([])
  })
  it('persists the local service list to SQLite and updates it after removal', async () => {
    await native.services()
    const path = join(home, '.local/share/serena-native/services.sqlite3')
    const rows = (): unknown[] => {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        return db.prepare('SELECT root, port, version FROM services').all()
      } finally {
        db.close()
      }
    }
    expect(rows()).toEqual([{ root: service.root, port: service.port, version: '2.0.0' }])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await registration().unregister(service.root)
    expect(rows()).toEqual([])
  })
  it('removes a stopped service through the preview confirmation flow', async () => {
    const preview = await manager.previewNative(`native:${service.id}`, 'unregisterNative')
    expect(await manager.execute(preview.id)).toEqual({
      action: 'unregisterNative',
      outcome: 'completed'
    })
    expect(await native.services()).toEqual([])
    await expect(manager.execute(preview.id)).rejects.toThrow('expiredPreview')
  })
  it('requires a loaded service to be stopped before manual removal', async () => {
    loaded = true
    await expect(manager.previewNative(`native:${service.id}`, 'unregisterNative')).rejects.toThrow(
      'nativeRunning'
    )
  })
  it('reports an unknown root', async () => {
    await expect(registration().unregister(join(home, 'other'))).rejects.toThrow('notRegistered')
  })
  it('removes host entries that still point at the unregistered service', async () => {
    const other = { url: 'http://127.0.0.1:40000/mcp' }
    await mkdir(join(service.root, '.cursor'))
    await mkdir(join(service.root, '.codex'))
    await writeFile(
      join(service.root, '.mcp.json'),
      JSON.stringify({ mcpServers: { serena: { type: 'http', url: service.url }, other } })
    )
    await writeFile(
      join(service.root, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { serena: { url: service.url } } })
    )
    await writeFile(
      join(service.root, '.codex/config.toml'),
      `model = "x"\n[mcp_servers.serena]\nurl = "${service.url}"\n`
    )
    await mkdir(join(service.root, '.kiro/settings'), { recursive: true })
    const repointed = JSON.stringify({ mcpServers: { serena: other } })
    await writeFile(join(service.root, '.kiro/settings/mcp.json'), repointed)
    await registration().unregister(service.root)
    expect(JSON.parse(await readFile(join(service.root, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { other }
    })
    await expect(stat(join(service.root, '.cursor/mcp.json'))).rejects.toThrow()
    expect(await readFile(join(service.root, '.codex/config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(await readFile(join(service.root, '.kiro/settings/mcp.json'), 'utf8')).toBe(repointed)
    expect(await readdir(join(home, '.Trash'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^serena-[0-9a-f]{16}-\.cursor_mcp\.json-/)])
    )
  })
  it('controls a service by its registered root', async () => {
    await native.controlRoot(service.root, 'startNative')
    expect(loaded).toBe(true)
    await native.controlRoot(service.root, 'restartNative')
    expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(2)
    await expect(native.controlRoot(join(home, 'other'), 'stopNative')).rejects.toThrow(
      'notRegistered'
    )
  })
})

describe('resume at login', () => {
  it('restarts a service left running and skips one stopped on purpose', async () => {
    await native.controlRoot(service.root, 'startNative')
    loaded = false
    expect(await native.resume()).toEqual({ started: [service.root], failed: [] })
    expect(loaded).toBe(true)
    await native.controlRoot(service.root, 'stopNative')
    expect(await native.resume()).toEqual({ started: [], failed: [] })
    expect(loaded).toBe(false)
  })
  it('adopts a running service that has no recorded state', async () => {
    loaded = true
    expect(await native.resume()).toEqual({ started: [], failed: [] })
    expect(
      JSON.parse(await readFile(join(service.directory, 'desired-state.json'), 'utf8'))
    ).toEqual({ state: 'running' })
  })
  it('leaves services without a record stopped', async () => {
    expect(await native.resume()).toEqual({ started: [], failed: [] })
    expect(run.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false)
  })
  it('installs a login agent that runs the CLI through the App executable', async () => {
    const executable = '/Applications/Proxy RS.app/Contents/MacOS/Proxy RS'
    expect(await installResumeAgent(home, executable)).toBe(true)
    const plist = await readFile(
      join(home, 'Library/LaunchAgents/com.proxy-rs.serena.resume.plist'),
      'utf8'
    )
    expect(plist).toContain(`<string>${executable}</string>`)
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<string>resume</string>')
    expect(await installResumeAgent(home, executable)).toBe(false)
    const empty = await realpath(await mkdtemp(join(home, 'fresh-')))
    expect(await installResumeAgent(empty, executable)).toBe(false)
  })
  it('keeps admission exemptions fail-closed when the list cannot be read', async () => {
    const path = join(home, '.local/share/serena-native/exemptions.json')
    expect((await native.snapshot()).snapshot.instances[0].exempt).toBe(false)
    await native.setExempt(service.root, true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      roots: [service.root]
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await native.snapshot()).snapshot.instances[0].exempt).toBe(true)
    await expect(native.setExempt(join(home, 'missing-project'), true)).rejects.toThrow(
      'notRegistered'
    )
    expect(JSON.parse(await readFile(path, 'utf8')).roots).toEqual([service.root])
    await chmod(path, 0o644)
    const broken = await native.snapshot()
    expect(broken.snapshot.issues).toContain('exemptionListInvalid')
    expect(broken.snapshot.instances[0].exempt).toBe(false)
    await expect(native.setExempt(service.root, false)).rejects.toThrow('exemptionListInvalid')
    expect(JSON.parse(await readFile(path, 'utf8')).roots).toEqual([service.root])
  })
})

describe('bundled CLI installation', () => {
  it('installs once, links the shell entry, and skips identical copies', async () => {
    const source = join(home, 'bundled.cjs')
    await writeFile(source, '#!/usr/bin/env node\n')
    const target = join(home, '.local/share/serena-native/tools/serena-native.cjs')
    expect(await installNativeCli(home, source)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('#!/usr/bin/env node\n')
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect(await readlink(join(home, '.local/bin/serena-native'))).toBe(target)
    expect(await installNativeCli(home, source)).toBe(false)
  })
  it('does nothing before the native runtime directory exists', async () => {
    const empty = await realpath(await mkdtemp(join(home, 'fresh-')))
    expect(await installNativeCli(empty, join(home, 'missing.cjs'))).toBe(false)
    await expect(stat(join(empty, '.local'))).rejects.toThrow()
  })
})
