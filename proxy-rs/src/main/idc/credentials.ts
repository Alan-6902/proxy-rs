// AWS 凭据解析：手填 AK/SK 优先，否则读本机 ~/.aws/credentials 指定 profile

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IdcCredentialConfig, ResolvedCredentials } from './types'

const DEFAULT_PROFILE = 'default'
const DEFAULT_REGION = 'us-east-1'

/** 解析 AWS ini 文件（credentials / config 同格式） */
function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      // config 文件里 profile 段写作 [profile foo]，credentials 里写作 [foo]，统一成 foo
      current = sectionMatch[1].trim().replace(/^profile\s+/, '')
      sections[current] = sections[current] || {}
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    sections[current][key] = value
  }
  return sections
}

async function readIniIfExists(path: string): Promise<Record<string, Record<string, string>>> {
  try {
    return parseIni(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 解析出可用凭据。
 *
 * profile 模式只读静态 AK/SK，不支持 SSO 缓存或 assume-role 链
 * （那些需要走 STS 换票，本模块暂不涉及）。碰到这类 profile 会明确报错，
 * 而不是静默降级成匿名请求。
 */
export async function resolveCredentials(
  config: IdcCredentialConfig
): Promise<ResolvedCredentials> {
  const region = (config.region || '').trim() || DEFAULT_REGION

  if (config.source === 'manual') {
    const accessKeyId = (config.accessKeyId || '').trim()
    const secretAccessKey = (config.secretAccessKey || '').trim()
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('未填写 AWS Access Key ID / Secret Access Key')
    }
    const sessionToken = (config.sessionToken || '').trim()
    return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined, region }
  }

  const profile = (config.profile || '').trim() || DEFAULT_PROFILE
  const awsDir = join(homedir(), '.aws')
  const credFile = await readIniIfExists(join(awsDir, 'credentials'))
  const configFile = await readIniIfExists(join(awsDir, 'config'))

  const section = credFile[profile] || configFile[profile]
  if (!section) {
    const available = Array.from(new Set([...Object.keys(credFile), ...Object.keys(configFile)]))
    throw new Error(
      `~/.aws 下未找到 profile "${profile}"` +
        (available.length
          ? `（可用：${available.join(', ')}）`
          : '（credentials 与 config 均不存在或为空）')
    )
  }

  const accessKeyId = section['aws_access_key_id'] || ''
  const secretAccessKey = section['aws_secret_access_key'] || ''
  if (!accessKeyId || !secretAccessKey) {
    if (section['sso_start_url'] || section['sso_session']) {
      throw new Error(
        `profile "${profile}" 是 SSO 配置，本模块不支持 SSO 换票。` +
          '请改用手填 AK/SK，或在该 profile 下写入静态 aws_access_key_id / aws_secret_access_key'
      )
    }
    if (section['role_arn'] || section['source_profile']) {
      throw new Error(`profile "${profile}" 需要 assume-role，本模块不支持。请改用手填 AK/SK`)
    }
    throw new Error(`profile "${profile}" 缺少 aws_access_key_id / aws_secret_access_key`)
  }

  // region 优先用用户在应用里选的；没选才回落 profile 里的
  const profileRegion = section['region'] || configFile[profile]?.['region'] || ''
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: section['aws_session_token'] || undefined,
    region: (config.region || '').trim() || profileRegion || DEFAULT_REGION
  }
}

/** 列出本机可用 profile 名，供前端下拉选择 */
export async function listAwsProfiles(): Promise<string[]> {
  const awsDir = join(homedir(), '.aws')
  const credFile = await readIniIfExists(join(awsDir, 'credentials'))
  const configFile = await readIniIfExists(join(awsDir, 'config'))
  return Array.from(new Set([...Object.keys(credFile), ...Object.keys(configFile)])).sort()
}
