import nodemailer from 'nodemailer'

export interface KskEmailCredential {
  key: string
  region: string
}

export interface KskEmailConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  from: string
  to: string
}

/** 从 `Name <addr@host>` 或裸地址中取出邮箱地址，用于判断是否同一邮箱。 */
function extractAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return (match ? match[1] : value).trim().toLowerCase()
}

/** 收件邮箱支持逗号分隔多个地址；同一地址只保留一次，避免同一信箱收到多份。 */
export function parseKskEmailRecipients(value: string): string[] {
  const seen = new Set<string>()
  const recipients: string[] = []
  for (const entry of value.split(',')) {
    const recipient = entry.trim()
    if (!recipient) continue
    const address = extractAddress(recipient)
    if (seen.has(address)) continue
    seen.add(address)
    recipients.push(recipient)
  }
  return recipients
}

export async function sendKskAddedEmail(
  config: KskEmailConfig,
  credentials: KskEmailCredential[]
): Promise<number> {
  if (credentials.length === 0) return 0
  const recipients = parseKskEmailRecipients(config.to)
  if (!config.host.trim() || !config.from.trim() || recipients.length === 0) {
    throw new Error('邮件通知缺少 SMTP Host、发件人或收件人')
  }
  if (config.username.trim() && !config.password) throw new Error('SMTP 用户名已配置但密码为空')

  const transporter = nodemailer.createTransport({
    host: config.host.trim(),
    port: config.port,
    secure: config.secure,
    // 非隐式 TLS 端口必须升级到 STARTTLS，否则拒绝发送完整 KSK 与 SMTP 凭据。
    requireTLS: !config.secure,
    auth: config.username.trim()
      ? { user: config.username.trim(), pass: config.password }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000
  })
  try {
    await transporter.sendMail({
      from: config.from.trim(),
      to: recipients,
      subject: 'Proxy RS 新增 KSK',
      text: credentials.map((credential) => `${credential.key} (${credential.region})`).join('\n')
    })
    return credentials.length
  } finally {
    transporter.close()
  }
}
