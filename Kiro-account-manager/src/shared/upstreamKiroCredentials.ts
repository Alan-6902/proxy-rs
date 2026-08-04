export interface BackgroundRefreshCredentialPlan {
  credentialKind: 'oauth' | 'kiro_api_key'
  accessToken?: string
  kiroApiKey?: string
  shouldRefreshToken: boolean
  shouldFetchUserInfo: boolean
}

export interface BackgroundRefreshCredentialInput {
  credentialKind?: 'oauth' | 'kiro_api_key'
  accessToken?: string
  kiroApiKey?: string
  refreshToken?: string
}

export function resolveBackgroundRefreshPlan(
  credentials: BackgroundRefreshCredentialInput,
  needsTokenRefresh: boolean
): BackgroundRefreshCredentialPlan {
  const kiroApiKey = credentials.kiroApiKey?.trim()
  const credentialKind = credentials.credentialKind ?? (kiroApiKey ? 'kiro_api_key' : 'oauth')
  if (credentialKind === 'kiro_api_key') {
    return {
      credentialKind,
      kiroApiKey,
      shouldRefreshToken: false,
      shouldFetchUserInfo: false
    }
  }

  return {
    credentialKind: 'oauth',
    accessToken: credentials.accessToken?.trim(),
    shouldRefreshToken: needsTokenRefresh,
    shouldFetchUserInfo: true
  }
}
