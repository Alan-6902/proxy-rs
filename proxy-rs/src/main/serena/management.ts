import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, parse, relative } from 'node:path'
import { SERENA_FILE_LIMIT, type SerenaActionResult, type SerenaPreview } from '../../shared/serena'
import { SerenaError, SerenaInspector, within } from './runtimeInspector'
import type { InspectedRuntime } from './runtimeInspector'
import type { SerenaNativeAction } from '../../shared/serena'
import { NativeServices } from './nativeServices'
import { NativeRegistration, validateLanguages } from './nativeRegistration'

const PREVIEW_TTL_MS = 60_000
const SCAN_TIMEOUT_MS = 30_000
const MAX_PREVIEWS = 32
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'target',
  'build',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  'vendor',
  '.gradle'
])
interface ProjectCheck {
  root: string
  fileCount: number
  bytes: number
  languages: string[]
  fingerprint: string
  excludedPaths: string[]
}
interface PendingAction {
  preview: SerenaPreview
  fingerprint: string
  instanceId?: string
}

export class SerenaManagement {
  private snapshotPending?: Promise<InspectedRuntime>
  private readonly pending = new Map<string, PendingAction>()
  private readonly busyRoots = new Set<string>()
  readonly native: NativeServices
  constructor(readonly inspector: SerenaInspector) {
    this.native = new NativeServices(inspector)
  }

  async snapshot(): Promise<InspectedRuntime> {
    if (this.snapshotPending) return this.snapshotPending
    const operation = async (): Promise<InspectedRuntime> => {
      const inspected = await this.native.snapshot()
      let changed = false
      let failed = false
      for (const entry of inspected.entries.values()) {
        try {
          await lstat(entry.view.root)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        }
        if (this.busyRoots.has(entry.view.root)) continue
        this.busyRoots.add(entry.view.root)
        try {
          if (entry.view.native.loaded)
            await this.native.control(entry.view.id, 'stopNative', entry.fingerprint)
          await new NativeRegistration(this.inspector, this.native).unregister(
            entry.view.root,
            true
          )
          changed = true
        } catch {
          failed = true
        } finally {
          this.busyRoots.delete(entry.view.root)
        }
      }
      const result = changed ? await this.native.snapshot() : inspected
      if (failed) {
        result.snapshot.partial = true
        if (!result.snapshot.issues.includes('sourceUnavailable'))
          result.snapshot.issues.push('sourceUnavailable')
      }
      return result
    }
    this.snapshotPending = operation()
    try {
      return await this.snapshotPending
    } finally {
      this.snapshotPending = undefined
    }
  }

  async setExempt(instanceId: string, exempt: boolean): Promise<void> {
    const entry = (await this.native.entries()).get(instanceId)
    if (!entry) throw new SerenaError('notRegistered')
    if (this.busyRoots.has(entry.view.root)) throw new SerenaError('busy')
    this.busyRoots.add(entry.view.root)
    try {
      await this.native.setExempt(entry.service.root, exempt)
    } finally {
      this.busyRoots.delete(entry.view.root)
    }
  }

  async previewNative(instanceId: string, action: SerenaNativeAction): Promise<SerenaPreview> {
    const entry = (await this.native.entries()).get(instanceId)
    if (!entry) throw new SerenaError('invalidRequest')
    if (action === 'unregisterNative') {
      if (entry.loaded) throw new SerenaError('nativeRunning')
    } else {
      const blocked = entry.view.native?.blocked
      if (blocked && !(action === 'stopNative' && blocked === 'nativeLegacyConflict'))
        throw new SerenaError(blocked)
      if ((action === 'startNative') === entry.loaded) throw new SerenaError('stateChanged')
    }
    const preview: SerenaPreview = {
      id: randomUUID(),
      action,
      root: entry.service.root,
      pid: entry.view.pid,
      expiresAt: Date.now() + PREVIEW_TTL_MS
    }
    this.remember({ preview, fingerprint: entry.fingerprint, instanceId })
    return preview
  }

  async previewProject(path: string, selected?: string[]): Promise<SerenaPreview> {
    const project = await this.checkProject(path, selected)
    if ((await this.native.services()).some((item) => item.root === project.root))
      throw new SerenaError('alreadyRegistered')
    const preview: SerenaPreview = {
      id: randomUUID(),
      action: 'registerProject',
      root: project.root,
      pid: null,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      fileCount: project.fileCount,
      bytes: project.bytes,
      languages: project.languages
    }
    this.remember({ preview, fingerprint: project.fingerprint })
    return preview
  }

  async previewLanguages(id: string, selected: string[]): Promise<SerenaPreview> {
    const previous = this.confirmation(id)
    if (previous.action !== 'registerProject') throw new SerenaError('invalidRequest')
    this.pending.delete(id)
    return this.previewProject(previous.root, validateLanguages(selected))
  }

  private remember(action: PendingAction): void {
    for (const [id, value] of this.pending)
      if (value.preview.expiresAt < Date.now()) this.pending.delete(id)
    if (this.pending.size >= MAX_PREVIEWS) this.pending.delete(this.pending.keys().next().value!)
    this.pending.set(action.preview.id, action)
  }

  confirmation(id: string): SerenaPreview {
    const action = this.pending.get(id)
    if (!action || action.preview.expiresAt < Date.now()) throw new SerenaError('expiredPreview')
    return action.preview
  }

  async execute(id: string): Promise<SerenaActionResult> {
    const action = this.pending.get(id)
    this.pending.delete(id)
    if (!action || action.preview.expiresAt < Date.now()) throw new SerenaError('expiredPreview')
    const { preview } = action
    if (this.busyRoots.has(preview.root)) throw new SerenaError('busy')
    this.busyRoots.add(preview.root)
    try {
      if (['startNative', 'stopNative', 'restartNative'].includes(preview.action)) {
        await this.native.control(
          action.instanceId!,
          preview.action as SerenaNativeAction,
          action.fingerprint
        )
        return { action: preview.action, outcome: 'completed' }
      }
      if (preview.action === 'unregisterNative') {
        const entry = (await this.native.entries()).get(action.instanceId!)
        if (!entry || entry.fingerprint !== action.fingerprint)
          throw new SerenaError('stateChanged')
        await new NativeRegistration(this.inspector, this.native).unregister(preview.root)
        return { action: preview.action, outcome: 'completed' }
      }
      const project = await this.checkProject(preview.root, preview.languages)
      if (project.fingerprint !== action.fingerprint) throw new SerenaError('stateChanged')
      const registration = new NativeRegistration(this.inspector, this.native)
      const plan = await registration.prepare(project.root, project.languages)
      if (
        (await this.checkProject(preview.root, preview.languages)).fingerprint !==
        action.fingerprint
      )
        throw new SerenaError('stateChanged')
      await registration.publish(plan)
      await this.native.controlRoot(project.root, 'startNative')
      return { action: preview.action, outcome: 'completed' }
    } finally {
      this.busyRoots.delete(preview.root)
    }
  }

  async checkProject(
    path: string,
    selected?: string[],
    excludeExternalLinks = false,
    ignored: string[] = []
  ): Promise<ProjectCheck> {
    if (!isAbsolute(path)) throw new SerenaError('invalidProject')
    const root = await realpath(path)
    const home = await realpath(this.inspector.home)
    const forbidden = [
      home,
      parse(root).root,
      ...['Desktop', 'Downloads', 'cache', 'Library', '.serena', '.local'].map((name) =>
        join(home, name)
      )
    ]
    if (forbidden.includes(root) || !(await this.marker(root)))
      throw new SerenaError('invalidProject')
    const info = await lstat(root)
    if (!info.isDirectory()) throw new SerenaError('invalidProject')
    const configured = await this.inspector.projectLanguages(root)
    const detected = new Set<string>()
    const extensions: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'typescript',
      '.jsx': 'typescript',
      '.vue': 'vue',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.sh': 'bash',
      '.html': 'html',
      '.c': 'cpp',
      '.cpp': 'cpp',
      '.cs': 'csharp'
    }
    let languages = selected ? validateLanguages(selected) : configured
    const deadline = Date.now() + SCAN_TIMEOUT_MS
    const digest = createHash('sha256').update(
      `${root}\0${info.dev}\0${info.ino}\0${JSON.stringify(await this.inspector.projectConfiguration(root))}\0`
    )
    let fileCount = 0
    let bytes = 0
    if (
      ignored.some(
        (path) =>
          !path || isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '.')
      )
    )
      throw new SerenaError('unsafePath')
    const excludedPaths = new Set<string>(ignored)
    digest.update(JSON.stringify(ignored))
    const add = async (path: string): Promise<void> => {
      if (Date.now() > deadline) throw new SerenaError('commandUncertain')
      if (!within(root, path)) throw new SerenaError('unsafePath')
      if (ignored.some((name) => within(join(root, name), path))) return
      // lstat不跟随文件链接；父目录也必须保持在选择的项目边界内。
      const parent = await realpath(join(path, '..'))
      if (!within(root, parent)) {
        if (!excludeExternalLinks) throw new SerenaError('unsafePath')
        let current = root
        for (const part of relative(root, path).split('/').slice(0, -1)) {
          current = join(current, part)
          const link = await lstat(current)
          if (link.isSymbolicLink() && !within(root, await realpath(current))) {
            excludedPaths.add(relative(root, current))
            digest.update(`excluded:${current}:${link.ino}:${link.mtimeMs}`)
            return
          }
        }
        throw new SerenaError('unsafePath')
      }
      const file = await lstat(path)
      if (!file.isFile() && !file.isSymbolicLink()) return
      if (excludeExternalLinks && file.isSymbolicLink() && !within(root, await realpath(path))) {
        excludedPaths.add(relative(root, path))
        digest.update(`excluded:${path}:${file.ino}:${file.mtimeMs}`)
        return
      }
      const language = extensions[extname(path)]
      if (language) detected.add(language)
      fileCount++
      if (fileCount > SERENA_FILE_LIMIT) throw new SerenaError('projectTooLarge')
      bytes += file.size
      digest.update(`${path}\0${file.size}\0${file.mtimeMs}\0`)
    }
    let git = false
    try {
      const marker = await lstat(join(root, '.git'))
      git = !marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory())
    } catch {
      /* 非Git项目 */
    }
    if (git) {
      const listed = await this.inspector.run('/usr/bin/git', [
        '-C',
        root,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z'
      ])
      if (listed.code !== 0 || listed.timedOut) throw new SerenaError('sourceUnavailable')
      const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()
      if (paths.length > SERENA_FILE_LIMIT) throw new SerenaError('projectTooLarge')
      for (const name of paths) {
        if (isAbsolute(name) || !within(root, join(root, name))) throw new SerenaError('unsafePath')
        try {
          await add(join(root, name))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } else {
      const queue = [root]
      let visited = 0
      while (queue.length) {
        if (++visited > SERENA_FILE_LIMIT || Date.now() > deadline)
          throw new SerenaError('projectTooLarge')
        const directory = queue.pop()!
        if ((await realpath(directory)) !== directory || !within(root, directory))
          throw new SerenaError('unsafePath')
        for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name)
        )) {
          const path = join(directory, item.name)
          if (item.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(item.name)) queue.push(path)
          } else if (item.isFile()) await add(path)
        }
      }
    }
    if (!languages.length) languages = [...detected].sort()
    if (!languages.length) throw new SerenaError('languagesRequired')
    digest.update(languages.join(','))
    return {
      root,
      fileCount,
      bytes,
      languages,
      excludedPaths: [...excludedPaths].sort(),
      fingerprint: digest.digest('hex')
    }
  }

  private async marker(root: string): Promise<boolean> {
    for (const path of [join(root, '.git'), join(root, '.serena/project.yml')]) {
      try {
        const info = await lstat(path)
        if (
          !info.isSymbolicLink() &&
          (info.isFile() || info.isDirectory()) &&
          within(root, await realpath(path))
        )
          return true
      } catch {
        /* 尝试另一个项目根标记。 */
      }
    }
    return false
  }
}
