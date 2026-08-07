import type { AccountCredentials } from '../types/account'

export function serializeAccountCredentialsForClipboard(credentials: AccountCredentials): string {
  const copyableCredentials =
    credentials.credentialKind === 'kiro_api_key' || credentials.kiroApiKey
      ? { kiroApiKey: credentials.kiroApiKey }
      : {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret
        }

  return JSON.stringify(copyableCredentials, null, 2)
}
