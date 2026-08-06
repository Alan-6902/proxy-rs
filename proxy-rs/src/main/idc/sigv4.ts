// AWS SigV4 请求签名
//
// 为什么自己实现而不引 @aws-sdk：本模块只需要打 5 个固定端点，
// 引整套 SDK 会给 Electron 包体增加数 MB，且这里有几个内部 API
// （SWBUPService / AWSZornControlPlaneService）本来就没有 SDK client。
// SigV4 本身是稳定算法，crypto 够用。

import { createHash, createHmac } from 'node:crypto'
import type { ResolvedCredentials } from './types'

const ALGORITHM = 'AWS4-HMAC-SHA256'

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** SigV4 时间戳：20260806T121530Z 与 20260806 */
function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * URI 路径规范化。
 * 本模块所有目标端点路径都是 "/"，但保留通用实现以免后续加端点时踩坑。
 * 注意 SigV4 对路径段做 RFC3986 编码，且不对已编码的 "/" 二次编码。
 */
function canonicalUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  return pathname
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/')
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** AWS JSON 协议版本。identitystore / sso-admin 是 1.1，几个内部 API 是 1.0 */
export type JsonProtocolVersion = '1.0' | '1.1'

/**
 * 用 SigV4 签一个 AWS JSON 协议的 POST 请求。
 *
 * @param service SigV4 signing name。注意与端点主机名不一定一致：
 *   identitystore 主机 + identitystore signing（AWSIdentityStore.*，JSON 1.1），
 *   sso 主机 + sso signing（SWBExternalService.*，JSON 1.1），
 *   identitystore 主机 + userpool signing（SWBUPService.UpdatePassword，JSON 1.0），
 *   codewhisperer 主机 + q signing（AmazonQDeveloperService.*，JSON 1.0），
 *   service.user-subscriptions 主机 + user-subscriptions signing（JSON 1.0）。
 * @param target X-Amz-Target 值
 * @param jsonVersion Content-Type 里的 json 版本，默认 1.0
 */
export function signJsonRequest(opts: {
  url: string
  service: string
  target: string
  payload: unknown
  credentials: ResolvedCredentials
  jsonVersion?: JsonProtocolVersion
  now?: Date
}): SignedRequest {
  const { url, service, target, payload, credentials } = opts
  const parsed = new URL(url)
  const body = JSON.stringify(payload)
  const { amzDate, dateStamp } = formatAmzDate(opts.now ?? new Date())
  const region = credentials.region
  const contentType = `application/x-amz-json-${opts.jsonVersion ?? '1.0'}`

  // ---- canonical request ----
  const payloadHash = sha256Hex(body)
  const headersToSign: Record<string, string> = {
    'content-type': contentType,
    host: parsed.host,
    'x-amz-date': amzDate,
    'x-amz-target': target
  }
  if (credentials.sessionToken) {
    headersToSign['x-amz-security-token'] = credentials.sessionToken
  }

  const sortedKeys = Object.keys(headersToSign).sort()
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersToSign[k].trim()}\n`).join('')
  const signedHeaders = sortedKeys.join(';')

  const canonicalRequest = [
    'POST',
    canonicalUri(parsed.pathname),
    parsed.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  // ---- string to sign ----
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  // ---- signing key ----
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': target,
    Authorization: authorization
  }
  if (credentials.sessionToken) {
    headers['X-Amz-Security-Token'] = credentials.sessionToken
  }

  return { url, method: 'POST', headers, body }
}
