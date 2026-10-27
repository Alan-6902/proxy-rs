#!/usr/bin/env node
/** Native registration CLI; shares admission and transaction code with the desktop manager. */
import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SerenaInspector } from '../src/main/serena/runtimeInspector'
import { SerenaManagement } from '../src/main/serena/management'
import { NativeRegistration } from '../src/main/serena/nativeRegistration'
import { dedupeLanguageServers } from '../src/main/serena/languageServerDedupe'
import type { SerenaNativeAction } from '../src/shared/serena'

const CONTROL_ACTIONS: Record<string, SerenaNativeAction> = {
  start: 'startNative',
  stop: 'stopNative',
  restart: 'restartNative'
}
const USAGE =
  'Usage: serena-native preview|stage|register --root PATH [--languages typescript,python] [--port PORT] [--confirm] | start|stop|restart --root PATH --confirm | refresh --confirm [--restart] | dedupe --confirm | unregister --root PATH --confirm | resume | inspect'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      languages: { type: 'string' },
      port: { type: 'string' },
      confirm: { type: 'boolean' },
      restart: { type: 'boolean' },
      'exclude-external-links': { type: 'boolean' },
      'exclude-paths': { type: 'string' }
    }
  })
  const manager = new SerenaManagement(new SerenaInspector())
  const action = positionals[0]
  if (action === 'inspect') {
    process.stdout.write(JSON.stringify((await manager.snapshot()).snapshot) + '\n')
    return
  }
  if (action === 'resume') {
    await manager.snapshot()
    const result = await manager.native.resume()
    process.stdout.write(
      JSON.stringify({ state: 'resumed', at: new Date().toISOString(), ...result }) + '\n'
    )
    if (result.failed.length) process.exitCode = 1
    return
  }
  if (Object.hasOwn(CONTROL_ACTIONS, action)) {
    if (!values.root) throw new Error(`${action} requires --root PATH`)
    if (!values.confirm) throw new Error(`${action} requires explicit user approval (--confirm)`)
    await manager.native.controlRoot(values.root, CONTROL_ACTIONS[action])
    process.stdout.write(JSON.stringify({ state: action, root: values.root }) + '\n')
    return
  }
  if (action === 'dedupe') {
    if (!values.confirm) throw new Error('dedupe requires explicit user approval (--confirm)')
    const result = await dedupeLanguageServers(await manager.native.services())
    process.stdout.write(JSON.stringify({ state: 'deduplicated', ...result }) + '\n')
    return
  }
  if (action === 'refresh' || action === 'unregister') {
    if (action === 'unregister' && !values.root) throw new Error('unregister requires --root PATH')
    if (!values.confirm) throw new Error(`${action} requires explicit user approval (--confirm)`)
    const registration = new NativeRegistration(manager.inspector, manager.native)
    if (action === 'refresh') {
      const refreshed = await registration.refresh()
      const restarted: string[] = []
      const failed: Array<{ root: string; error: string }> = []
      if (values.restart) {
        const loaded = [...(await manager.native.entries()).values()]
          .filter((entry) => entry.loaded && refreshed.includes(entry.service.root))
          .map((entry) => entry.service.root)
        for (const root of loaded) {
          try {
            await manager.native.controlRoot(root, 'restartNative')
            restarted.push(root)
          } catch (error) {
            failed.push({ root, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      process.stdout.write(
        JSON.stringify({ state: 'refreshed', roots: refreshed, restarted, failed }) + '\n'
      )
      if (failed.length) process.exitCode = 1
    } else {
      await registration.unregister(values.root!)
      process.stdout.write(JSON.stringify({ state: 'unregistered', root: values.root }) + '\n')
    }
    return
  }
  if (!values.root || !['preview', 'stage', 'register'].includes(action)) throw new Error(USAGE)
  const selected = values.languages?.split(',').filter(Boolean)
  const ignored = values['exclude-paths']?.split(',').filter(Boolean) ?? []
  const project = await manager.checkProject(
    values.root,
    selected,
    values['exclude-external-links'],
    ignored
  )
  if (action === 'preview') {
    process.stdout.write(JSON.stringify(project) + '\n')
    return
  }
  if (!values.confirm)
    throw new Error('Registration/staging requires explicit user approval (--confirm)')
  const registration = new NativeRegistration(manager.inspector, manager.native)
  const plan = await registration.prepare(
    project.root,
    project.languages,
    values.port ? Number(values.port) : undefined,
    project.excludedPaths
  )
  if (
    (
      await manager.checkProject(
        project.root,
        project.languages,
        values['exclude-external-links'],
        ignored
      )
    ).fingerprint !== project.fingerprint
  )
    throw new Error('Project changed during preparation')
  if (action === 'stage') {
    const directory = join(manager.inspector.home, '.local/share/serena-native/migrations', plan.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(directory, 'staged-plan.json'),
      JSON.stringify({ project, plan }, null, 2),
      { mode: 0o600, flag: 'wx' }
    )
    process.stdout.write(
      JSON.stringify({ state: 'staged', root: project.root, path: directory, port: plan.port }) +
        '\n'
    )
    return
  }
  await registration.publish(plan)
  await manager.native.controlRoot(project.root, 'startNative')
  process.stdout.write(
    JSON.stringify({
      state: 'registered',
      root: project.root,
      port: plan.port,
      migration: plan.id,
      started: true
    }) + '\n'
  )
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Native operation failed') + '\n')
  process.exitCode = 1
})
