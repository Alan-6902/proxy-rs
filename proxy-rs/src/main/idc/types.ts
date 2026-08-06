// AWS Identity Center 席位管理类型
//
// 跨进程共享的档位常量与数据结构统一放在 shared/idcSeats.ts，
// 这里只 re-export 供本目录内引用，另加主进程独有的类型。

export {
  COMMON_AWS_REGIONS,
  DEFAULT_SEAT_CONCURRENCY,
  KIRO_TIER,
  KIRO_TIER_ORDER,
  MAX_SEATS_PER_PLAN,
  SUBSCRIPTION_TYPE_TO_TIER,
  TIER_ALIASES,
  TIER_MONTHLY_CREDITS,
  TIER_MONTHLY_PRICE_USD,
  TIER_SEQ_PREFIX,
  TIER_TO_ASSIGNMENT_TYPE,
  estimateMonthlyCost
} from '../../shared/idcSeats'

export type {
  BatchOpResult,
  BatchOpTarget,
  ExistingSeat,
  IdcCredentialConfig,
  IdcCredentialSource,
  IdcIpcResult,
  IdcUser,
  KiroTier,
  PlannedSeat,
  ProvisionSummary,
  SeatInventory,
  SeatProgressEvent,
  SeatProvisionResult,
  SeatQuotaRequest,
  SeatStepStatus
} from '../../shared/idcSeats'

/** 解析后的可用凭据。只在主进程内流转，不经过 IPC */
export interface ResolvedCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
