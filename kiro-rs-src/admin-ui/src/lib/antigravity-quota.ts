import type { AgAccount, AgQuotaBucket, AgQuotaGroup, AgQuotaModel } from '../types/api'

/** 一行额度；fraction 为 null 表示上游没给，显示「—」 */
export interface QuotaRow {
  key: string
  label: string
  fraction: number | null
  resetTime: string | null
}

const FAMILY_CLAUDE = 'Claude / GPT 通用'
const FAMILY_GEMINI = 'Gemini'
const FAMILY_ARGON = 'Gemini 4 Argon'

/** 同一模型的思考档位后缀，额度共享，合并成一个模型看 */
const TIER_SUFFIX = /-(high|medium|low|tiered|thinking)$/
/** 档位展示名后缀，如「Claude Opus 5.5 (High)」→「Claude Opus 5.5」 */
const TIER_LABEL_SUFFIX = /\s*\([^)]*\)$/
/** 非对话模型或缩水版，不参与「最好的模型」挑选 */
const EXCLUDED = /lite|image/

const familyOf = (group: AgQuotaGroup) => {
  const text = [group.displayName, ...group.buckets.map((b) => `${b.bucketId ?? ''} ${b.displayName ?? ''}`)]
    .join(' ')
    .toLowerCase()
  if (text.includes('argon')) return FAMILY_ARGON
  if (/claude|gpt|3p/.test(text)) return FAMILY_CLAUDE
  return FAMILY_GEMINI
}

/** 一类模型的挑选规则：rank 返回 null 表示不属于该类，数值越大越好 */
interface Category {
  key: string
  fallbackLabel: string
  families: (modelId: string) => string[]
  rank: (modelId: string) => number | null
}

const version = (major: string, minor = '0') => Number(major) + Number(minor) / 100

const CATEGORIES: Category[] = [
  {
    key: 'claude',
    fallbackLabel: 'Claude',
    families: () => [FAMILY_CLAUDE],
    // 版本优先，同版本 Opus 优于 Sonnet
    rank: (id) => {
      const m = /^claude-(opus|sonnet)-(\d+)-(\d+)/.exec(id)
      return m ? version(m[2], m[3]) * 10 + (m[1] === 'opus' ? 1 : 0) : null
    },
  },
  {
    key: 'flash',
    fallbackLabel: 'Gemini Flash',
    families: () => [FAMILY_GEMINI],
    rank: (id) => {
      const m = /^gemini-(\d+)(?:\.(\d+))?-flash/.exec(id)
      return m && !EXCLUDED.test(id) ? version(m[1], m[2]) : null
    },
  },
  {
    key: 'gemini',
    fallbackLabel: 'Gemini',
    families: (id) => (id.includes('argon') ? [FAMILY_GEMINI, FAMILY_ARGON] : [FAMILY_GEMINI]),
    rank: (id) => {
      const m = /^gemini-(\d+)(?:\.(\d+))?-/.exec(id)
      return m && !id.includes('flash') && !EXCLUDED.test(id) ? version(m[1], m[2]) : null
    },
  },
]

const baseId = (id: string) => id.replace(TIER_SUFFIX, '')

/** 取最紧的一个约束：剩余最少的那个决定能用多少，也决定什么时候恢复 */
const tightest = (limits: { fraction: number | null; resetTime: string | null }[]) => {
  const known = limits.filter((l): l is { fraction: number; resetTime: string | null } => l.fraction !== null)
  if (known.length === 0) return { fraction: null, resetTime: null }
  return known.reduce((min, l) => (l.fraction < min.fraction ? l : min))
}

const categoryRow = (category: Category, models: AgQuotaModel[], groups: AgQuotaGroup[]): QuotaRow | null => {
  const ranked = models
    .map((m) => ({ m, rank: category.rank(m.id) }))
    .filter((x): x is { m: AgQuotaModel; rank: number } => x.rank !== null)
  if (ranked.length === 0) return null
  const best = ranked.reduce((a, b) => (b.rank > a.rank ? b : a)).m
  const variants = models.filter((m) => baseId(m.id) === baseId(best.id))
  const families = category.families(best.id)
  const buckets: AgQuotaBucket[] = groups.filter((g) => families.includes(familyOf(g))).flatMap((g) => g.buckets)
  const { fraction, resetTime } = tightest([
    ...variants.map((m) => ({ fraction: m.remainingFraction, resetTime: m.resetTime })),
    ...buckets.map((b) => ({ fraction: b.remainingFraction, resetTime: b.resetTime })),
  ])
  const label = variants.map((m) => m.displayName?.replace(TIER_LABEL_SUFFIX, '')).find(Boolean)
    ?? category.fallbackLabel
  return { key: category.key, label, fraction, resetTime }
}

/**
 * 只看三件事：最好的 Claude、最好的 Flash、最好的 Gemini。
 * 每行剩余额度取该模型自身额度与所属分组 5h / Weekly 窗口中最少的一个，恢复时间跟随这个最紧的约束。
 */
export function quotaRows(account: Pick<AgAccount, 'quota'>): QuotaRow[] {
  const models = account.quota?.models ?? []
  const groups = account.quota?.groups ?? []
  return CATEGORIES.map((c) => categoryRow(c, models, groups)).filter((r): r is QuotaRow => r !== null)
}
