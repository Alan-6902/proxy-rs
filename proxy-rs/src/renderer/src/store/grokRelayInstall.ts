import { create } from 'zustand'
import type { GrokRelayInstallProgress } from '../../../shared/grokAccounts'
import { errorText } from '../components/cursor/_helpers'

/**
 * Grok relay 路由安装的跨页面状态。
 *
 * 安装要跑几分钟，活在主进程干；页面切走再切回时组件已经重建，本地 state 全丢，看起来像「进度没了」。
 * 所以「正在装谁、最新进度、最近一次结果」放在这里：页面任何时候挂载都能接着显示；装完时页面不在，
 * 切回来也能从 outcome 里补一条提示。
 */

export interface GrokRelayInstallOutcome {
  scope: string
  /** 成功提示与失败提示二者只有一个。 */
  notice?: string
  error?: string
  at: number
}

interface GrokRelayInstallState {
  installingScope: string | null
  progress: GrokRelayInstallProgress | null
  outcome: GrokRelayInstallOutcome | null
  /**
   * 让某个号的 Bot 给自己的 Box 装 relay 路由并等到结果。同一时间只跑一个；prefix 用于切号后自动
   * 触发时把「已切换到 X」接在结果前面。
   */
  run: (input: { scope: string; name: string; prefix?: string }) => Promise<void>
  /** 页面把 outcome 展示出来后调用，避免下次挂载重复弹。 */
  consumeOutcome: () => void
}

export const useGrokRelayInstallStore = create<GrokRelayInstallState>((set, get) => ({
  installingScope: null,
  progress: null,
  outcome: null,

  run: async ({ scope, name, prefix }) => {
    if (get().installingScope) return
    set({ installingScope: scope, progress: null, outcome: null })
    const lead = prefix ? `${prefix}，` : ''
    let outcome: GrokRelayInstallOutcome
    try {
      const result = await window.api.grokAccountsEnsureRelayRoute(scope)
      if (!result.success) throw new Error(result.error)
      const seconds = Math.round(result.data.elapsedMs / 1000)
      if (result.data.status === 'ready') {
        outcome = {
          scope,
          at: Date.now(),
          notice: result.data.installed
            ? `${lead}Bot「${result.data.agentName}」已给 ${name} 的 Box 装好 relay 路由（用了 ${seconds} 秒）`
            : `${lead}${name} 的 Box 上 relay 路由本来就在`
        }
      } else {
        outcome = {
          scope,
          at: Date.now(),
          error:
            `${lead}已让 Bot「${result.data.agentName}」去装 relay 路由，但等了 ${Math.round(seconds / 60)} 分钟探针仍没通` +
            `${result.data.lastStatus != null ? `（最近返回 ${result.data.lastStatus}）` : ''}。` +
            (result.data.lastBotMessage
              ? `Bot 最后说：「${result.data.lastBotMessage}」。`
              : '去 Grok Bot 里看看它回了什么。') +
            '装好后点「探测 relay」；再点扳手会接着等，不会重复发指令。'
        }
      }
    } catch (error) {
      outcome = { scope, at: Date.now(), error: `${lead}${errorText(error, '装 relay 路由失败')}` }
    }
    set({ installingScope: null, progress: null, outcome })
  },

  consumeOutcome: () => set({ outcome: null })
}))

// 主进程推的阶段进度直接写进 store，和页面是否挂载无关
window.api.onGrokRelayInstallProgress((progress) => {
  useGrokRelayInstallStore.setState({ progress })
})
