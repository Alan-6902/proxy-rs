import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC, IPC_EVENT } from '../../src/shared/ipcChannels'

/**
 * 两侧对账：preload 暴露的每个请求通道，主进程都必须注册了 handler，反之亦然。
 * 这条规则曾被破坏过——设置页的 get/set-usage-api-type 在 main 侧被删，渲染层一直在调一个不存在的 handler。
 */

const ROOT = resolve(import.meta.dirname, '../../src')

function readTree(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) =>
      statSync(path).isDirectory()
        ? readTree(path)
        : path.endsWith('.ts')
          ? readFileSync(path, 'utf8')
          : ''
    )
    .join('\n')
}

const mainSource = readTree(join(ROOT, 'main'))
const preloadSource = readFileSync(join(ROOT, 'preload/index.ts'), 'utf8')

function keys(source: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(source.matchAll(pattern), (m) => m[1]))
}

/** 主进程发出但目前没有任何监听者的事件；新增条目前先确认确实无人需要 */
const MAIN_ONLY_EVENTS = new Set<keyof typeof IPC_EVENT>([
  // proxy-rs://auth/callback 协议回调：handleProtocolUrl 会发，但社交登录实际走 socialAuthCallback
  'authCallback'
])

describe('IPC 通道两侧对账', () => {
  it('每个请求通道在 preload 有 invoke、在 main 有 handle', () => {
    const handled = keys(mainSource, /ipcMain\.handle\(\s*IPC\.(\w+)/g)
    const invoked = keys(preloadSource, /ipcRenderer\.invoke\(\s*IPC\.(\w+)/g)
    const declared = new Set(Object.keys(IPC))

    expect(
      [...invoked].filter((k) => !handled.has(k)),
      'preload 调了但 main 没注册'
    ).toEqual([])
    expect(
      [...handled].filter((k) => !invoked.has(k)),
      'main 注册了但 preload 没暴露'
    ).toEqual([])
    expect(
      [...declared].filter((k) => !handled.has(k)),
      '声明了却无人使用'
    ).toEqual([])
  })

  it('每个事件通道两侧都有收发（显式登记的单侧事件除外）', () => {
    const sentByMain = keys(
      mainSource,
      /(?:webContents\.send|sendRendererEvent|ipcMain\.on)\(\s*IPC_EVENT\.(\w+)/g
    )
    const usedByPreload = keys(
      preloadSource,
      /ipcRenderer\.(?:on|send|removeListener)\(\s*IPC_EVENT\.(\w+)/g
    )

    expect(
      [...usedByPreload].filter((k) => !sentByMain.has(k)),
      'preload 用了但 main 没有'
    ).toEqual([])
    expect(
      [...sentByMain].filter(
        (k) => !usedByPreload.has(k) && !MAIN_ONLY_EVENTS.has(k as keyof typeof IPC_EVENT)
      ),
      'main 发了但 preload 没监听'
    ).toEqual([])
    expect(
      Object.keys(IPC_EVENT).filter((k) => !sentByMain.has(k) && !usedByPreload.has(k)),
      '声明了却无人使用'
    ).toEqual([])
  })

  it('IPC 与 IPC_EVENT 的通道名互不重复', () => {
    const all = [...Object.values(IPC), ...Object.values(IPC_EVENT)]
    expect(new Set(all).size).toBe(all.length)
  })
})
