type AccountRecord = Record<string, unknown> & {
  credentials?: Record<string, unknown> & {
    refreshToken?: unknown
  }
}

type AccountDataRecord = Record<string, unknown> & {
  accounts?: Record<string, AccountRecord>
}

export interface RotatedKiroCredentialUpdate {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  credentialRevision: string
}

export function mergeRotatedKiroCredentials(
  accountData: unknown,
  accountId: string,
  expectedRefreshToken: string | undefined,
  expectedCredentialRevision: string | undefined,
  update: RotatedKiroCredentialUpdate
): AccountDataRecord | null {
  if (!accountData || typeof accountData !== 'object' || Array.isArray(accountData)) return null
  const current = accountData as AccountDataRecord
  const account = current.accounts?.[accountId]
  if (!account) return null
  const credentials = account.credentials ?? {}
  if (
    credentials.refreshToken !== expectedRefreshToken ||
    credentials.credentialRevision !== expectedCredentialRevision
  ) {
    return null
  }

  const nextCredentials: Record<string, unknown> = {
    ...credentials,
    accessToken: update.accessToken
  }
  if (update.refreshToken !== undefined) nextCredentials.refreshToken = update.refreshToken
  if (update.expiresAt !== undefined) nextCredentials.expiresAt = update.expiresAt
  nextCredentials.credentialRevision = update.credentialRevision

  return {
    ...current,
    accounts: {
      ...current.accounts,
      [accountId]: {
        ...account,
        credentials: nextCredentials
      }
    }
  }
}

const ROTATED_KIRO_CREDENTIAL_FIELDS = [
  'accessToken',
  'refreshToken',
  'expiresAt'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Renderer saves are whole-snapshot writes. A renderer that has not observed a main-process
 * OAuth rotation must not overwrite the newly persisted token triplet with its stale copy.
 * Only an exact main-issued revision match may replace rotated fields.
 */
export function mergeAccountDataPreservingRotatedKiroCredentials(
  currentAccountData: unknown,
  incomingAccountData: unknown
): unknown {
  if (!isRecord(currentAccountData) || !isRecord(incomingAccountData)) return incomingAccountData
  const currentAccounts = currentAccountData.accounts
  const incomingAccounts = incomingAccountData.accounts
  if (!isRecord(currentAccounts) || !isRecord(incomingAccounts)) return incomingAccountData

  let changed = false
  const mergedAccounts: Record<string, unknown> = { ...incomingAccounts }
  for (const [accountId, incomingAccountValue] of Object.entries(incomingAccounts)) {
    const currentAccountValue = currentAccounts[accountId]
    if (!isRecord(currentAccountValue) || !isRecord(incomingAccountValue)) continue
    const currentCredentials = currentAccountValue.credentials
    const incomingCredentials = incomingAccountValue.credentials
    if (!isRecord(currentCredentials)) continue
    const currentRevision = currentCredentials.credentialRevision
    if (typeof currentRevision !== 'string' || currentRevision.length === 0) continue
    if (isRecord(incomingCredentials) && incomingCredentials.credentialRevision === currentRevision) {
      continue
    }

    const mergedCredentials: Record<string, unknown> = isRecord(incomingCredentials)
      ? { ...incomingCredentials }
      : {}
    for (const field of ROTATED_KIRO_CREDENTIAL_FIELDS) {
      if (hasOwn(currentCredentials, field)) mergedCredentials[field] = currentCredentials[field]
      else delete mergedCredentials[field]
    }
    mergedCredentials.credentialRevision = currentRevision
    mergedAccounts[accountId] = {
      ...incomingAccountValue,
      credentials: mergedCredentials
    }
    changed = true
  }

  if (!changed) return incomingAccountData
  return {
    ...incomingAccountData,
    accounts: mergedAccounts
  }
}

export class KiroCredentialRefreshSingleflight<T> {
  private readonly operations = new Map<string, Promise<T>>()

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.operations.get(key)
    if (existing) return existing
    const pending = Promise.resolve().then(operation)
    this.operations.set(key, pending)
    const cleanup = (): void => {
      if (this.operations.get(key) === pending) this.operations.delete(key)
    }
    void pending.then(cleanup, cleanup)
    return pending
  }

  activeCount(): number {
    return this.operations.size
  }
}

export function shouldReuseCanonicalKiroCredentials(
  canonical: { refreshToken?: string; credentialRevision?: string },
  expectedRefreshToken: string,
  expectedCredentialRevision?: string
): boolean {
  return (
    canonical.refreshToken !== expectedRefreshToken ||
    canonical.credentialRevision !== expectedCredentialRevision
  )
}

export function buildKiroCredentialRefreshSingleflightKey(params: {
  refreshToken: string
}): string {
  return params.refreshToken
}
