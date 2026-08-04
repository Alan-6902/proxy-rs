import type { ApiKey } from '../../src/main/proxy/types'

export function makeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'regular',
    name: 'regular',
    key: 'sk_test_regular_key',
    format: 'sk',
    enabled: true,
    createdAt: 0,
    usage: {
      totalRequests: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      daily: {}
    },
    ...overrides
  } satisfies ApiKey
}
