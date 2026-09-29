/** 主进程 IPC 的统一返回信封 */
export type IpcResult<T> = { success: true; data: T } | { success: false; error: string }
