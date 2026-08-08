/**
 * 单账号的「验活」与「推送到本机 Admin」两个动作。
 * 卡片视图与列表视图共用，避免两处各写一遍按钮状态与错误处理。
 */

import { useCallback, useMemo, useState } from 'react'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'
import {
  LOCAL_ADMIN_AUTH_METHOD,
  resolveLocalAdminCredentialPayload,
  type LocalAdminPushResult
} from '../../../shared/localAdminPush'

/** 推送结果提示在按钮上停留的时长。 */
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
          region: account.credentials.region
        })
        if (!response.success) throw new Error(response.error)
        const data: LocalAdminPushResult = response.data
        setPushState(data.status === 'existing' ? 'existing' : 'created')
        if (data.status === 'created' && !data.verified) {
          setPushError(isEn ? 'Added, but balance check failed' : '已添加，但余额验活未通过')
        }
      } catch (error) {
        setPushState('error')
        setPushError(error instanceof Error ? error.message : String(error))
      } finally {
        // 结果只是即时反馈，过一会儿回到可再次点击的初始态
        setTimeout(() => setPushState('idle'), PUSH_FEEDBACK_MS)
      }
    })()
  }, [resolved, pushState, account.credentials, isEn])

  const pushTitle = useMemo(() => {
    if (!resolved.ok) {
      return isEn
        ? `Cannot add to kiro-admin: ${resolved.reason}`
        : `无法添加到 kiro-admin：${resolved.reason}`
    }
    const label = AUTH_METHOD_LABEL[resolved.payload.authMethod]
    const method = isEn ? label.en : label.zh
    return isEn
      ? `Add to kiro-admin (${method})`
      : `添加到 kiro-admin（以 ${method} 凭据创建并验活）`
  }, [resolved, isEn])

  return {
    runLiveness,
    livenessPending,
    pushToAdmin,
    pushState,
    pushError: resolved.ok ? pushError : resolved.reason,
    canPush: resolved.ok,
    pushTitle
  }
}
