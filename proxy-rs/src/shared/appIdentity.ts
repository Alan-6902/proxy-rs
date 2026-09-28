export const APP_NAME = 'Proxy RS'
export const APP_ID = 'com.proxy.rs'
export const APP_PACKAGE_NAME = 'proxy-rs'
export const APP_DATA_DIRECTORY_NAME = APP_NAME
export const APP_PROTOCOL_SCHEME = APP_PACKAGE_NAME
// Kiro 的 Cognito 客户端只放行这个回调地址，不能跟着 APP_PROTOCOL_SCHEME 改名，
// 否则 Cognito 返回 redirect_mismatch，页面只剩 "An error was encountered with the requested page."。
// kiro:// 归 Kiro IDE 所有，本应用不向系统注册它，只在内置无痕浏览器里拦截这次跳转。
export const APP_SOCIAL_AUTH_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'

/** 内置浏览器里需要截下来交给应用处理的回调：本应用协议，或社交登录回调 */
export function isAppCallbackUrl(url: string): boolean {
  if (url.startsWith(`${APP_PROTOCOL_SCHEME}://`)) return true
  if (!url.startsWith(APP_SOCIAL_AUTH_REDIRECT_URI)) return false
  const rest = url.charAt(APP_SOCIAL_AUTH_REDIRECT_URI.length)
  return rest === '' || rest === '?' || rest === '#'
}
export const APP_PORTABLE_CONFIG_ID = APP_PACKAGE_NAME
export const APP_ACCOUNT_EXPORT_TYPE = `${APP_PACKAGE_NAME}-config`
export const APP_ACCOUNT_STORE_NAME = `${APP_PACKAGE_NAME}-accounts`
export const APP_ACCOUNT_STORE_ENCRYPTION_KEY = `${APP_PACKAGE_NAME}-account-store-v1`
