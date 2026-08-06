// SigV4 签名等价性测试
//
// 期望值由 botocore（AWS 官方 Python SDK 的签名实现）在钉死时间戳
// 2026-08-06T12:15:30Z 下生成，覆盖：
//   - JSON 1.1 + identitystore signing（公开 API）
//   - JSON 1.0 + q signing（内部订阅 API）
//   - 非 us-east-1 region（验证 region 进入 credential scope 与派生密钥）
//   - 临时凭据（x-amz-security-token 必须进 SignedHeaders）
//
// 签错任何一处，所有 AWS 调用都会 403，所以这里逐字节比对 Authorization。

import { describe, expect, it } from 'vitest'
import { signJsonRequest } from '../../src/main/idc/sigv4'
import type { ResolvedCredentials } from '../../src/main/idc/types'

const FIXED_NOW = new Date('2026-08-06T12:15:30.000Z')
const EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

const longTerm = (region: string): ResolvedCredentials => ({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: EXAMPLE_SECRET,
  region
})

describe('signJsonRequest', () => {
  it('matches botocore for identitystore (JSON 1.1)', () => {
    const signed = signJsonRequest({
      url: 'https://identitystore.us-east-1.amazonaws.com/',
      service: 'identitystore',
      target: 'AWSIdentityStore.CreateUser',
      payload: { IdentityStoreId: 'd-1234567890', UserName: 'john.smith@example.com' },
      credentials: longTerm('us-east-1'),
      jsonVersion: '1.1',
      now: FIXED_NOW
    })

    expect(signed.body).toBe(
      '{"IdentityStoreId":"d-1234567890","UserName":"john.smith@example.com"}'
    )
    expect(signed.headers['Content-Type']).toBe('application/x-amz-json-1.1')
    expect(signed.headers['X-Amz-Date']).toBe('20260806T121530Z')
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260806/us-east-1/identitystore/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-target, ' +
        'Signature=aacca6d4508ae23f7b8750bf5c0307e7cfe82dc17041128315bd11f4fe544ac9'
    )
  })

  it('matches botocore for CreateAssignment (JSON 1.0, q signing)', () => {
    const signed = signJsonRequest({
      url: 'https://codewhisperer.us-east-1.amazonaws.com/',
      service: 'q',
      target: 'AmazonQDeveloperService.CreateAssignment',
      payload: {
        principalId: 'abc-123',
        principalType: 'USER',
        subscriptionType: 'Q_DEVELOPER_STANDALONE_PRO'
      },
      credentials: longTerm('us-east-1'),
      jsonVersion: '1.0',
      now: FIXED_NOW
    })

    expect(signed.headers['Content-Type']).toBe('application/x-amz-json-1.0')
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260806/us-east-1/q/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-target, ' +
        'Signature=499f171a2ebb7ebdd4858fe2ed378dcebe335341084941a6cfe15b1d17f7ef05'
    )
  })

  it('folds region into scope and signing key (eu-west-1, empty payload)', () => {
    const signed = signJsonRequest({
      url: 'https://sso.eu-west-1.amazonaws.com/',
      service: 'sso',
      target: 'SWBExternalService.ListInstances',
      payload: {},
      credentials: longTerm('eu-west-1'),
      jsonVersion: '1.1',
      now: FIXED_NOW
    })

    expect(signed.body).toBe('{}')
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260806/eu-west-1/sso/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-target, ' +
        'Signature=db9e95b5abd2d2be322d0c535b2f3ccd0bf8950384faf9856b0e4250332a9bde'
    )
  })

  it('signs x-amz-security-token for temporary credentials', () => {
    const signed = signJsonRequest({
      url: 'https://identitystore.us-east-1.amazonaws.com/',
      service: 'userpool',
      target: 'SWBUPService.UpdatePassword',
      payload: { UserId: 'u-1', PasswordMode: 'EMAIL' },
      credentials: {
        accessKeyId: 'ASIATEMPEXAMPLE',
        secretAccessKey: EXAMPLE_SECRET,
        sessionToken: 'FQoGZXIvYXdzEXAMPLESESSIONTOKEN',
        region: 'us-east-1'
      },
      jsonVersion: '1.0',
      now: FIXED_NOW
    })

    // token 必须既进 SignedHeaders 又作为请求头发出
    expect(signed.headers['X-Amz-Security-Token']).toBe('FQoGZXIvYXdzEXAMPLESESSIONTOKEN')
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=ASIATEMPEXAMPLE/20260806/us-east-1/userpool/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, ' +
        'Signature=c0ea6f0d6781d495c9ce93b0616bd079a8dea2036ebd1e81eb275c3660b13251'
    )
  })

  it('defaults to JSON 1.0 when jsonVersion is omitted', () => {
    const signed = signJsonRequest({
      url: 'https://codewhisperer.us-east-1.amazonaws.com/',
      service: 'q',
      target: 'AmazonQDeveloperService.DeleteAssignment',
      payload: { principalId: 'x', principalType: 'USER' },
      credentials: longTerm('us-east-1'),
      now: FIXED_NOW
    })
    expect(signed.headers['Content-Type']).toBe('application/x-amz-json-1.0')
  })
})
