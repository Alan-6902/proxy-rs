import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  SerenaInspector,
  parseProcesses,
  readBounded,
  type CommandResult,
  type SerenaRunner
} from '../../src/main/serena/runtimeInspector'
import { SerenaManagement } from '../../src/main/serena/management'
import { NativeRegistration, validateLanguages } from '../../src/main/serena/nativeRegistration'
import { nativeArguments, nativeService } from '../../src/main/serena/nativeServices'

const START = 'Sun Oct 18 01:37:55 2026'
const ok = (stdout = '', code = 0): CommandResult => ({ stdout, code, timedOut: false })
let home: string
let root: string
let inspector: SerenaInspector
let management: SerenaManagement
let runner: Mock<SerenaRunner>
async function file(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'serena-manager-test-')))
  root = join(home, 'project')
  await file(
    join(root, '.serena/project.yml'),
    'language_servers: [typescript]\nignored_paths: [generated]\n'
  )
  await file(join(root, '.git'), 'gitdir: fixture')
  await file(join(root, 'source.ts'), 'export const sample = 1\n')
  await file(
    join(home, '.local/share/serena-native/runtime/2.0.0/bin/serena'),
    'fixture, never executed'
  )
  await file(
    nativeService(home, root, 39101).certificateFile,
    'fixture CA, never used for networking'
  )
  runner = vi.fn(async (path, args) => {
    if (path === '/usr/bin/git') return ok('source.ts\0.serena/project.yml\0')
    if (path === '/usr/sbin/lsof') return ok('', 1)
    if (path === '/bin/launchctl' && args[0] === 'print') return ok('', 113)
    if (path === '/usr/bin/plutil') {
      const service = nativeService(home, root, 39101)
      return ok(
        JSON.stringify({
          Label: service.label,
          WorkingDirectory: service.directory,
          ProgramArguments: nativeArguments(service),
          EnvironmentVariables: {
            SERENA_HOME: service.home,
            SSL_CERT_FILE: service.certificateFile
          },
          KeepAlive: true,
          StandardOutPath: join(service.directory, 'stdout.log'),
          StandardErrorPath: join(service.directory, 'stderr.log')
        })
      )
    }
    return ok()
  })
  inspector = new SerenaInspector({ home, platform: 'darwin', run: runner })
  management = new SerenaManagement(inspector)
})
afterEach(async () => {
  vi.restoreAllMocks()
  const trash = join(homedir(), '.Trash')
  await mkdir(trash, { recursive: true })
  await rename(home, join(trash, home.split('/').at(-1)!))
})

describe('native-only inspection', () => {
  it('parses process fingerprints without executing command text', () => {
    expect(parseProcesses(`111 1 ${START} 1.5 2048 python native-server`)[0]).toMatchObject({
      pid: 111,
      ppid: 1,
      start: START,
      cpu: 1.5,
      rssKiB: 2048
    })
    expect(parseProcesses('bad process output')).toEqual([])
  })
  it('has a working empty snapshot without legacy installation or metadata', async () => {
    const { snapshot } = await management.snapshot()
    expect(snapshot).toMatchObject({
      version: '2.0.0',
      registrationAvailable: true,
      instances: [],
      registeredRoots: [],
      issues: []
    })
    expect(runner.mock.calls.some(([path]) => path.includes('guard'))).toBe(false)
  })
  it('checks URLs against roots and never exposes credentials', async () => {
    await file(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          serena: { url: 'http://127.0.0.1:39101/mcp', headers: { Authorization: 'SECRET' } }
        }
      })
    )
    await file(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { serena: { command: 'serena', env: { KEY: 'HIDDEN' } } } })
    )
    const registrations = await inspector.registrations(
      [{ root, url: 'http://127.0.0.1:39101/mcp' }],
      () => {}
    )
    expect(registrations.find((entry) => entry.source === join(root, '.mcp.json'))?.matches).toBe(
      true
    )
    expect(
      registrations.find((entry) => entry.source === join(home, '.claude.json'))?.matches
    ).toBe(false)
    expect(JSON.stringify(registrations)).not.toMatch(/SECRET|HIDDEN/)
  })
  it('rejects symlinked and oversized sources', async () => {
    const outside = join(home, 'outside.txt')
    await file(outside, 'private')
    await symlink(outside, join(root, 'alias'))
    await expect(readBounded(join(root, 'alias'), root)).rejects.toThrow('unsafePath')
    await expect(readBounded(outside, home, 2)).rejects.toThrow('sourceUnavailable')
  })
  it('does not run commands on unsupported platforms', async () => {
    const other = new SerenaManagement(
      new SerenaInspector({ home, platform: 'linux', run: runner })
    )
    expect((await other.snapshot()).snapshot.issues).toEqual(['unsupported'])
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('native registration', () => {
  it('rejects unknown language identifiers before publishing configuration', () => {
    expect(() => validateLanguages(['typescrip'])).toThrow('languagesRequired')
    expect(() => validateLanguages(['c'])).toThrow('languagesRequired')
    expect(validateLanguages(['cpp', 'python', 'python'])).toEqual(['cpp', 'python'])
  })
  it('previews without writes, then registers and starts the service once', async () => {
    const preview = await management.previewProject(root)
    expect(preview).toMatchObject({
      action: 'registerProject',
      root,
      fileCount: 2,
      languages: ['typescript']
    })
    const registry = join(home, '.local/share/serena-native/registry.json')
    await expect(readFile(registry)).rejects.toMatchObject({ code: 'ENOENT' })
    await file(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'keep' },
          'serena-docs': { url: 'https://docs.invalid/mcp' }
        }
      })
    )
    expect(await management.execute(preview.id)).toEqual({
      action: 'registerProject',
      outcome: 'completed'
    })
    const data = JSON.parse(await readFile(registry, 'utf8'))
    expect(data.services).toEqual([{ root, port: 39101, version: '2.0.0' }])
    const registeredService = nativeService(home, root, 39101)
    const launchDefinition = await readFile(registeredService.plist, 'utf8')
    expect(launchDefinition).toContain(join(home, 'go/bin'))
    expect(launchDefinition).toContain(registeredService.certificateFile)
    expect(launchDefinition).toContain(
      `<key>WorkingDirectory</key><string>${registeredService.directory}</string>`
    )
    const host = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
    expect(host.mcpServers.other.command).toBe('keep')
    expect(host.mcpServers['serena-docs'].url).toBe('https://docs.invalid/mcp')
    expect(host.mcpServers.serena).toEqual({ type: 'http', url: 'http://127.0.0.1:39101/mcp' })
    expect(runner.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toEqual([
      ['/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, registeredService.plist]]
    ])
    expect(
      runner.mock.calls.some(([, args]) => ['bootout', 'authorize', 'release'].includes(args[0]))
    ).toBe(false)
    expect(
      JSON.parse(await readFile(join(registeredService.directory, 'desired-state.json'), 'utf8'))
    ).toEqual({ state: 'running' })
    await expect(management.execute(preview.id)).rejects.toThrow('expiredPreview')
    await expect(management.previewProject(root)).rejects.toThrow('alreadyRegistered')
    expect((await management.snapshot()).snapshot.registeredRoots).toEqual([root])
  })
  it('rejects broad roots and oversized listings', async () => {
    await expect(management.previewProject(home)).rejects.toThrow('invalidProject')
    const original = runner.getMockImplementation()!
    runner.mockImplementation((path, args) =>
      path === '/usr/bin/git'
        ? Promise.resolve(ok(Array.from({ length: 30_001 }, (_, i) => `file${i}.ts`).join('\0')))
        : original(path, args)
    )
    await expect(management.previewProject(root)).rejects.toThrow('projectTooLarge')
  })
  it('suggests languages without starting an LSP and permits reviewed corrections', async () => {
    await file(join(root, '.serena/project.yml'), 'project_name: example\n')
    const preview = await management.previewProject(root)
    expect(preview.languages).toEqual(['typescript'])
    const corrected = await management.previewLanguages(preview.id, ['typescript', 'python'])
    expect(corrected.languages).toEqual(['typescript', 'python'])
    await expect(management.execute(preview.id)).rejects.toThrow('expiredPreview')
    expect(runner.mock.calls.every(([path]) => path === '/usr/bin/git')).toBe(true)
  })
  it('invalidates confirmation after source or effective configuration changes', async () => {
    const preview = await management.previewProject(root)
    await file(join(root, 'source.ts'), 'changed content')
    await expect(management.execute(preview.id)).rejects.toThrow('stateChanged')
    const next = await management.previewProject(root)
    await file(join(root, '.serena/project.local.yml'), 'ignored_paths: [changed]\n')
    await expect(management.execute(next.id)).rejects.toThrow('stateChanged')
  })
  it('does not overwrite concurrent host changes or publish a stale registry', async () => {
    const registration = new NativeRegistration(inspector, management.native)
    const prepared = await registration.prepare(root, ['typescript'])
    await file(join(root, '.cursor/mcp.json'), '{"mcpServers":{"user":{"command":"keep"}}}')
    await expect(registration.publish(prepared)).rejects.toThrow('stateChanged')
    await expect(
      readFile(join(home, '.local/share/serena-native/registry.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('accepts comment-only local overrides', async () => {
    await file(join(root, '.serena/project.local.yml'), '# local overrides\n')
    expect((await management.previewProject(root)).languages).toEqual(['typescript'])
  })
  it('excludes external links only with explicit scope approval and carries exclusions into native settings', async () => {
    await file(join(home, 'outside/external.py'), 'private = 1\n')
    await symlink(join(home, 'outside'), join(root, 'linked'))
    const original = runner.getMockImplementation()!
    runner.mockImplementation((path, args) =>
      path === '/usr/bin/git'
        ? Promise.resolve(ok('source.ts\0linked/external.py\0'))
        : original(path, args)
    )
    await expect(management.checkProject(root)).rejects.toThrow('unsafePath')
    const checked = await management.checkProject(root, undefined, true)
    expect(checked.excludedPaths).toEqual(['linked'])
    expect(checked.fileCount).toBe(1)
    const registration = new NativeRegistration(inspector, management.native)
    const plan = await registration.prepare(
      root,
      checked.languages,
      undefined,
      checked.excludedPaths
    )
    expect(
      plan.changes.find((item) => item.path.endsWith('/project/project.yml'))?.after
    ).toContain('linked/**')
  })
  it('refuses activation commands instead of executing them', async () => {
    await file(join(root, '.serena/project.local.yml'), 'on_activate: ["touch /do-not-run"]\n')
    const registration = new NativeRegistration(inspector, management.native)
    await expect(registration.prepare(root, ['typescript'])).rejects.toThrow('nativeConfigInvalid')
  })
  it('hides Lombok-generated symbols in the service config of Java projects', async () => {
    const registration = new NativeRegistration(inspector, management.native)
    const serenaConfig = async (languages: string[]): Promise<Record<string, unknown>> =>
      parseYaml(
        (await registration.prepare(root, languages)).changes.find((item) =>
          item.path.endsWith('/home/serena_config.yml')
        )!.after
      )
    const java = await serenaConfig(['java'])
    expect(java.trusted_project_path_patterns).toEqual([])
    expect(java.ls_specific_settings).toEqual({ java: { lombok_show_generated: false } })
    expect((await serenaConfig(['typescript'])).ls_specific_settings).toBeUndefined()
  })
})

it.skipIf(process.env.SERENA_READONLY_SMOKE !== '1')(
  'reads real native services without controlling them',
  async () => {
    const { snapshot } = await new SerenaManagement(new SerenaInspector()).snapshot()
    expect(snapshot.sampledAt).toBeGreaterThan(0)
    process.stdout.write(
      JSON.stringify({
        version: snapshot.version,
        count: snapshot.instances.length,
        issues: snapshot.issues
      }) + '\n'
    )
  }
)
