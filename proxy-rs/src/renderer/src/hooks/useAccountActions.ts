/**
 * 单账号的「验活」与「推送到本机 Admin」两个动作。
 * 卡片视图与列表视图共用，避免两处各写一遍按钮状态与错误处理。
 */

import { useCallback, useMemo, useState } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { askConfirm } from '@/components/ui/confirmDialogStore'
import type { Account } from '@/types/account'
import {
  LOCAL_ADMIN_AUTH_METHOD,
  resolveLocalAdminCredentialPayload,
  type LocalAdminPushResult
} from '../../../shared/localAdminPush'

/** 推送成功提示在按钮上停留的时长。失败不走这个定时器，见 pushToAdmin 的注释。 */
const PUSH_FEEDBACK_MS = 4000

export type AdminPushState = 'idle' | 'pushing' | 'created' | 'existing' | 'error'

interface UseAccountActions {
  /** 验活：结果写进 store 的 livenessResults，由卡片/行上的验活徽标呈现 */
  runLiveness: () => void
  /** 本轮验活是否进行中（该账号自己的那一条） */
  livenessPending: boolean
  /** 推送到本机 Admin */
  pushToAdmin: () => void
  pushState: AdminPushState
  /** 推送失败原因，或凭据不满足推送条件的原因 */
  pushError?: string
  /** 弹窗展示完整失败原因（错误常被截断），确认即重试推送 */
  showPushError: () => void
  /** 手动收起失败提示 */
  dismissPushError: () => void
  /** 该账号的凭据是否可推送；false 时按钮置灰，原因见 pushError */
  canPush: boolean
  /** 按钮 title：说明将要推什么，或为什么不能推 */
  pushTitle: string
}

const AUTH_METHOD_LABEL: Record<string, { zh: string; en: string }> = {
  [LOCAL_ADMIN_AUTH_METHOD.API_KEY]: { zh: 'API Key', en: 'API Key' },
  [LOCAL_ADMIN_AUTH_METHOD.IDC]: { zh: 'IdC', en: 'IdC' },
  [LOCAL_ADMIN_AUTH_METHOD.SOCIAL]: { zh: 'Social', en: 'Social' }
}

export function useAccountActions(account: Account, isEn: boolean): UseAccountActions {
  const runAccountLiveness = useAccountsStore((state) => state.runAccountLiveness)
  const livenessPending = useAccountsStore(
    (state) => state.livenessResults.get(account.id) === null
  )

  const [pushState, setPushState] = useState<AdminPushState>('idle')
  const [pushError, setPushError] = useState<string>()

  const resolved = useMemo(
    () => resolveLocalAdminCredentialPayload(account.credentials),
    [account.credentials]
  )

  const runLiveness = useCallback(() => {
    void runAccountLiveness(account.id)
  }, [runAccountLiveness, account.id])

  const pushToAdmin = useCallback(() => {
    if (!resolved.ok || pushState === 'pushing') return
    setPushState('pushing')
    setPushError(undefined)
    void (async () => {
      try {
        const response = await window.api.kskAutomationPushAccountToLocalAdmin({
          credentialKind: account.credentials.credentialKind,
          kiroApiKey: account.credentials.kiroApiKey,
          refreshToken: account.credentials.refreshToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod
        })
        // 只有明确永久失效才会回滚并抛错；transient 会保留凭据并作为成功返回
        if (!response.success) throw new Error(response.error)
        const data: LocalAdminPushResult = response.data
        setPushState(data.status === 'existing' ? 'existing' : 'created')
        // 成功只是即时反馈，过一会儿回到可再次点击的初始态
        setTimeout(() => setPushState('idle'), PUSH_FEEDBACK_MS)
      } catch (error) {
        /*
         * 失败态不自动消失。原先失败也走定时器（12 秒后清空），而失败原因只存在于
         * 按钮的原生 title 里——用户得在这十几秒内把鼠标悬到那个小图标上等系统 tooltip，
         * 实际等于看不到。现在保留到用户自己收起或重试为止。
         */
        setPushState('error')
        setPushError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [resolved, pushState, account.credentials])

  const dismissPushError = useCallback(() => {
    setPushState('idle')
    setPushError(undefined)
  }, [])

  /**
   * 弹窗展示完整失败原因。
   *
   * 错误串里含「哪一道门禁没过 + 是否已回滚删除凭据」，卡片上那一行放不下；
   * 确认按钮直接重试，省得再找一遍那个小图标。
   */
  const showPushError = useCallback(() => {
    if (!pushError) return
    void (async () => {
      const retry = await askConfirm({
        title: isEn ? 'Failed to add to kiro-admin' : '推送到 kiro-admin 失败',
        description: pushError,
        confirmText: isEn ? 'Retry' : '重试推送',
        cancelText: isEn ? 'Close' : '关闭',
        tone: 'warning'
      })
      if (retry) pushToAdmin()
      else dismissPushError()
    })()
  }, [pushError, isEn, pushToAdmin, dismissPushError])

  const pushTitle = useMemo(() => {
    if (!resolved.ok) {
      return isEn
        ? `Cannot add to kiro-admin: ${resolved.reason}`
        : `无法添加到 kiro-admin：${resolved.reason}`
    }
    const label = AUTH_METHOD_LABEL[resolved.payload.authMethod]
    const method = isEn ? label.en : label.zh
    return isEn
      ? `Add to kiro-admin (${method}); only permanently invalid credentials are removed, transient failures are kept`
      : `添加到 kiro-admin（以 ${method} 凭据创建；仅明确失效才删除，暂时性故障会保留）`
  }, [resolved, isEn])

  return {
    runLiveness,
    livenessPending,
    pushToAdmin,
    pushState,
    pushError: resolved.ok ? pushError : resolved.reason,
    showPushError,
    dismissPushError,
    canPush: resolved.ok,
    pushTitle
  }
}
