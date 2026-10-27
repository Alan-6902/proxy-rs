import { beforeEach, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeService, type NativeService } from '../../src/main/serena/nativeServices'
import { dedupeLanguageServers } from '../../src/main/serena/languageServerDedupe'

const JAR = 'EclipseJDTLS/server/plugin.jar'
const MODES = [0o644, 0o750]
let home: string
let services: NativeService[]
const staticPath = (service: NativeService, path: string): string =>
  join(service.home, 'language_servers', 'static', path)
const inode = async (service: NativeService, path: string): Promise<number> =>
  (await stat(staticPath(service, path))).ino
async function file(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'serena-dedupe-test-')))
  services = [
    nativeService(home, join(home, 'a'), 39101),
    nativeService(home, join(home, 'b'), 39102)
  ]
  for (const [index, service] of services.entries()) {
    await file(staticPath(service, JAR), 'same jar')
    await chmod(staticPath(service, JAR), MODES[index])
    await file(staticPath(service, 'EclipseJDTLS/server/version.txt'), `${service.port}`)
    await file(staticPath(service, 'EclipseJDTLS/workspaces/hash/data_dir/state'), 'same state')
    await file(staticPath(service, 'lsp/EclipseJDTLS/sharedIndex/index'), 'same index')
  }
})

it('clones identical install files and leaves differing or mutable files alone', async () => {
  const untouched = [
    'EclipseJDTLS/server/version.txt',
    'EclipseJDTLS/workspaces/hash/data_dir/state',
    'lsp/EclipseJDTLS/sharedIndex/index'
  ]
  const jarsBefore = await Promise.all(services.map((service) => inode(service, JAR)))
  const untouchedBefore = await Promise.all(
    services.flatMap((service) => untouched.map((path) => inode(service, path)))
  )
  expect(await dedupeLanguageServers(services)).toEqual({ files: 1, bytes: 'same jar'.length })
  const replaced = (
    await Promise.all(
      services.map(async (service, index) => (await inode(service, JAR)) !== jarsBefore[index])
    )
  ).flatMap((changed, index) => (changed ? [index] : []))
  expect(replaced).toHaveLength(1)
  const target = staticPath(services[replaced[0]], JAR)
  expect(await readFile(target, 'utf8')).toBe('same jar')
  expect((await stat(target)).mode & 0o777).toBe(MODES[replaced[0]])
  expect(
    await Promise.all(services.flatMap((service) => untouched.map((path) => inode(service, path))))
  ).toEqual(untouchedBefore)
})

it('skips services that have not downloaded language servers yet', async () => {
  expect(await dedupeLanguageServers([nativeService(home, join(home, 'c'), 39103)])).toEqual({
    files: 0,
    bytes: 0
  })
})
