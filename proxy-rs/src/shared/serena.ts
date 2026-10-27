import type { IpcResult } from './ipcResult'

export const SERENA_CHANNEL = {
  snapshot: 'serena:snapshot',
  previewNative: 'serena:preview-native',
  chooseProject: 'serena:choose-project',
  previewLanguages: 'serena:preview-languages',
  execute: 'serena:execute',
  setExempt: 'serena:set-exempt'
} as const

export const SERENA_REFRESH_MS = 10_000
export const SERENA_CONFIRM_HOLD_MS = 2_000
export const SERENA_FILE_LIMIT = 30_000
export const SERENA_REGISTRY_BYTES = 1024 * 1024
/** 语言服务器子孙进程合计 CPU（ps 的近期平均）达到该值视为高负载。 */
export const SERENA_LS_BUSY_CPU = 90
/** 高负载持续这么久仍不回落，提示可能卡住（JDTLS 不会取消已超时的请求）。 */
export const SERENA_LS_STUCK_MS = 5 * 60_000
export type SerenaProcessState = 'matched' | 'missing' | 'mismatch' | 'unknown'
export type SerenaNativeAction = 'startNative' | 'stopNative' | 'restartNative' | 'unregisterNative'
export type SerenaAction = 'registerProject' | SerenaNativeAction
export type SerenaIssue =
  | 'unsupported'
  | 'sourceUnavailable'
  | 'partial'
  | 'identityUnverified'
  | 'configurationOverlap'
  | 'invalidRequest'
  | 'expiredPreview'
  | 'stateChanged'
  | 'busy'
  | 'commandFailed'
  | 'commandUncertain'
  | 'invalidProject'
  | 'projectTooLarge'
  | 'languagesRequired'
  | 'unsafePath'
  | 'cancelled'
  | 'nativeRegistryInvalid'
  | 'nativeConfigInvalid'
  | 'nativeLegacyConflict'
  | 'nativeStillStopping'
  | 'nativePortBusy'
  | 'nativeRunning'
  | 'notRegistered'
  | 'alreadyRegistered'
  | 'registrationIncomplete'
  | 'exemptionListInvalid'

export interface SerenaInstance {
  id: string
  root: string
  binding: 'registry-process' | 'candidate'
  backend: 'native-http'
  pid: number | null
  started: string | null
  processState: SerenaProcessState
  port: number
  listening: boolean | null
  cpu: number | null
  rssKiB: number | null
  languageServer: { cpu: number; rssKiB: number; busySince: number | null } | null
  languages: string[]
  recordedStatus: string | null
  exempt: boolean
  native: {
    version: string
    url: string
    label: string
    loaded: boolean
    blocked: SerenaIssue | null
  }
}

export interface SerenaRegistration {
  source: string
  name: string
  transport: 'stdio' | 'http' | 'unknown'
  matches: boolean
}

export interface SerenaSnapshot {
  sampledAt: number
  version: string | null
  registrationAvailable: boolean
  instances: SerenaInstance[]
  registeredRoots: string[]
  registrations: SerenaRegistration[]
  issues: SerenaIssue[]
  partial: boolean
}

export interface SerenaPreview {
  id: string
  action: SerenaAction
  root: string
  pid: number | null
  expiresAt: number
  fileCount?: number
  bytes?: number
  languages?: string[]
}

export interface SerenaActionResult {
  action: SerenaAction
  outcome: 'completed' | 'uncertain'
}

export interface SerenaApi {
  snapshot(): Promise<IpcResult<SerenaSnapshot>>
  previewNative(id: string, action: SerenaNativeAction): Promise<IpcResult<SerenaPreview>>
  chooseProject(): Promise<IpcResult<SerenaPreview | null>>
  previewLanguages(id: string, languages: string[]): Promise<IpcResult<SerenaPreview>>
  execute(id: string): Promise<IpcResult<SerenaActionResult>>
  setExempt(id: string, exempt: boolean): Promise<IpcResult<void>>
}
