import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string | number): string {
  const d = new Date(date)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 拆分卡密/凭证行。分隔符优先级：---- > Tab > 连续空格。
 * refreshToken/clientSecret 为 base64url(JWT)，可能以 '-' 结尾，与 '----' 相邻会形成 5+ 个连续 '-'。
 * 用 /-{4,}/ 整体匹配分隔符，并把多出的 (N-4) 个 '-' 归还前一字段，避免 JWT 被截断、末字段(provider) 多出前导 '-'。
 */
export function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) {
    const parts: string[] = []
    const re = /-{4,}/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      parts.push(line.slice(last, m.index) + '-'.repeat(m[0].length - 4))
      last = m.index + m[0].length
    }
    parts.push(line.slice(last))
    return parts
  }
  if (line.includes('\t')) return line.split('\t')
  return line.split(/\s{2,}/)
}
