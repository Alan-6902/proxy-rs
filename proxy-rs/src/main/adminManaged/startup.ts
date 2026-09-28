/** 所有能刷新账号 token 的调度器都必须等待托管登记加载与升级认领。 */
export async function startManagedAccountRefresh(steps: {
  reload: () => Promise<unknown>
  adopt: () => Promise<void>
  start: () => void
}): Promise<void> {
  await steps.reload()
  await steps.adopt()
  steps.start()
}
