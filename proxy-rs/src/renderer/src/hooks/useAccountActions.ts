/**
 * 单账号的「验活」与「推送到本机 Admin」两个动作。
 * 卡片视图与列表视图共用，避免两处各写一遍按钮状态与错误处理。
 */

import { useKiroCliAccountId } from './useKiroCliAccount'
import { useCallback, useMemo, useState } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { askConfirm } from '@/components/ui/confirmDialogStore'
import type { Account } from '@/types/account'
import { canRefreshUpstreamCredential } from '@/types/account'
import {
  LOCAL_ADMIN_AUTH_METHOD,
  resolveLocalAdminCredentialPayload,
  type LocalAdminPushResult
} from '../../../shared/localAdminPush'

/** 成功提示在按钮上停留的时长（推送 / 切 CLI）。失败不走这个定时器，见 pushToAdmin 的注释。 */
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
  /** 账号库模式下该账号是否在反代号池中；未启用账号库时为 undefined */
  inPool?: boolean
  /** 按钮 title：说明将要推什么，或为什么不能推 */
  pushTitle: string
  /** 把该账号切换为 Kiro CLI 当前账号 */
  switchToCli: () => void
  cliSwitchState: CliSwitchState
  /** 只有带 Refresh Token 的 OAuth 账号能切 CLI */
  canSwitchCli: boolean
  cliSwitchTitle: string
  /** Kiro CLI 当前登录的就是这个账号（它的 token 由 kiro-cli 自己刷新） */
  isCliCurrent: boolean
}

export type CliSwitchState = 'idle' | 'switching' | 'done'

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

  // email 在 Account 上而不在 credentials 里，得单独拼进 candidate
  const resolved = useMemo(
    () => resolveLocalAdminCredentialPayload({ ...account.credentials, email: account.email }),
    [account.credentials, account.email]
  )

  const runLiveness = useCallback(() => {
    void runAccountLiveness(account.id)
  }, [runAccountLiveness, account.id])

  /*
   * 账号库模式：账号本来就在共享库里，"加入反代"只是把它放进号池，不需要再推一份凭据
   * （渲染层也已经拿不到明文凭据）。inPool 为真时按钮变成"移出号池"。
   */
  const accountDb = account.accountDb
  const inPool = accountDb?.inPool === true

  const setPool = useCallback(
    (next: boolean) => {
      if (pushState === 'pushing') return
      setPushState('pushing')
      setPushError(undefined)
      void (async () => {
        const result = await window.api.accountDbSetInPool(account.id, next)
        if (result.success) {
          setPushState(next ? 'created' : 'existing')
          setTimeout(() => setPushState('idle'), PUSH_FEEDBACK_MS)
          // 号池状态在库里，重新读一次账号列表才能刷新徽标
          void useAccountsStore.getState().reloadAccountsFromMain()
          return
        }
        setPushState('error')
        setPushError(result.error || (isEn ? 'Unknown error' : '未知错误'))
      })()
    },
    [account.id, pushState, isEn]
  )

  const pushToAdmin = useCallback(() => {
    if (accountDb) {
      setPool(!inPool)
      return
    }
    if (!resolved.ok || pushState === 'pushing') return
    setPushState('pushing')
    setPushError(undefined)
    void (async () => {
      try {
        const response = await window.api.kskAutomationPushAccountToLocalAdmin({
          // 推送成功后主进程据此登记「已托管」，此后本地不再刷新这个账号的 Token
          accountId: account.id,
          credentialKind: account.credentials.credentialKind,
          kiroApiKey: account.credentials.kiroApiKey,
          refreshToken: account.credentials.refreshToken,
          // 推送探针只用它发消息验活，不再用 refreshToken 本地现刷——本地那份在
          // Admin 刷过之后已经作废，拿它判失效会误删 Admin 里刚建好的凭据。
          accessToken: account.credentials.accessToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod,
          // Admin 靠它把凭据卡片标成邮箱，否则那边只显示「凭据 #2」
          email: account.email
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
  }, [accountDb, inPool, setPool, resolved, pushState, account.credentials, account.email])

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
    if (accountDb) {
      return inPool
        ? isEn
          ? 'In the reverse-proxy pool — click to remove it (the account itself is kept)'
          : '已在反代号池中，点击移出（账号仍保留在账号库里）'
        : isEn
          ? 'Add this account to the reverse-proxy pool'
          : '把该账号加入反代号池（由 kiro-rs 接单）'
    }
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
  }, [accountDb, inPool, resolved, isEn])

  const switchAccountToCli = useAccountsStore((state) => state.switchAccountToCli)
  const adminManagedIds = useAccountsStore((state) => state.adminManagedIds)
  const [cliSwitchState, setCliSwitchState] = useState<CliSwitchState>('idle')
  const isCliCurrent = useKiroCliAccountId() === account.id
  const isAdminManaged = adminManagedIds.has(account.id)
  /*
   * 托管账号的凭据由反代维护，本地那份已被轮换作废，切到 CLI 只会得到一份死 token。
   *
   * 账号库模式例外：凭据在共享库里、kiro-rs 持续续期，切号写进 CLI 的是当前有效值，
   * 之后每次续期都会自动同步给 CLI，所以这里不拦。
   */
  const canSwitchCli =
    canRefreshUpstreamCredential(account.credentials) && (accountDb ? true : !isAdminManaged)

  const switchToCli = useCallback(() => {
    if (!canSwitchCli || cliSwitchState === 'switching') return
    setCliSwitchState('switching')
    void (async () => {
      const result = await switchAccountToCli(account.id)
      if (result.success) {
        setCliSwitchState('done')
        setTimeout(() => setCliSwitchState('idle'), PUSH_FEEDBACK_MS)
        return
      }
      setCliSwitchState('idle')
      const retry = await askConfirm({
        title: isEn ? 'Failed to switch Kiro CLI' : '切换 Kiro CLI 失败',
        description: result.error || (isEn ? 'Unknown error' : '未知错误'),
        confirmText: isEn ? 'Retry' : '重试',
        cancelText: isEn ? 'Close' : '关闭',
        tone: 'warning'
      })
      if (retry) switchToCli()
    })()
  }, [canSwitchCli, cliSwitchState, switchAccountToCli, account.id, isEn])

  const cliSwitchTitle = !canSwitchCli
    ? isAdminManaged && !accountDb
      ? isEn
        ? 'Managed by the local proxy — its credentials are not maintained here'
        : '该账号由本机反代托管，凭据不在本地维护，请在反代侧使用'
      : isEn
        ? 'Only OAuth accounts with a refresh token can be used by Kiro CLI'
        : '只有带 Refresh Token 的 OAuth 账号能切到 Kiro CLI'
    : cliSwitchState === 'done'
      ? isEn
        ? 'Kiro CLI switched to this account'
        : 'Kiro CLI 已切换到该账号'
      : isCliCurrent
        ? isEn
          ? 'Kiro CLI is logged in with this account; its token is refreshed by kiro-cli, not kiro-rs'
          : 'Kiro CLI 当前登录的就是这个账号：token 由 kiro-cli 自己刷新，kiro-rs 不刷新它'
        : isEn
          ? 'Switch Kiro CLI to this account (refreshes the token first)'
          : '切换 Kiro CLI 到该账号（会先刷新一次 Token）'

  return {
    runLiveness,
    livenessPending,
    pushToAdmin,
    pushState,
    pushError: resolved.ok ? pushError : resolved.reason,
    showPushError,
    dismissPushError,
    // 账号库模式：账号已入库即可切号池状态，不需要渲染层持有凭据
    canPush: accountDb ? true : resolved.ok,
    /** 账号库模式下该账号是否在反代号池中；未启用账号库时为 undefined */
    inPool: accountDb ? inPool : undefined,
    pushTitle,
    switchToCli,
    cliSwitchState,
    canSwitchCli,
    cliSwitchTitle,
    isCliCurrent
  }
}
