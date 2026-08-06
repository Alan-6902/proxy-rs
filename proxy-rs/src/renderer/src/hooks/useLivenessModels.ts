/**
 * useLivenessModels hook
 * 验活可用模型列表：优先代理缓存模型，回退 Kiro 可用模型，结果持久化到 localStorage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/** 验活常用模型候选（可在输入框自定义其它模型 ID） */
export const LIVENESS_MODELS = [
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-3.7-sonnet',
  'auto'
]

const MODEL_STORAGE_KEY = 'kiro-liveness-model'
const MODELS_CACHE_KEY = 'kiro-liveness-models-cache'

interface UseLivenessModels {
  /** 当前选中的模型 ID（写入即持久化） */
  model: string
  setModel: (model: string) => void
  /** datalist 候选 = 缓存的真实模型 ∪ 内置候选 */
  modelOptions: string[]
  /** 缓存到的真实模型数量，用于按钮文案 */
  cachedCount: number
  loading: boolean
  reload: () => Promise<void>
}

export function useLivenessModels(): UseLivenessModels {
  const [model, setModel] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY) || LIVENESS_MODELS[0]
    } catch {
      return LIVENESS_MODELS[0]
    }
  })
  const [cachedModels, setCachedModels] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(MODELS_CACHE_KEY)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      /* ignore */
    }
    return []
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    } catch {
      /* ignore */
    }
  }, [model])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      let models: string[] = []
      try {
        const r = await window.api.proxyGetModels()
        if (r.success && r.models?.length) models = r.models.map((m) => m.id)
      } catch {
        /* 代理未启动则忽略，走下面回退 */
      }
      if (models.length === 0) {
        try {
          const r = await window.api.getKiroAvailableModels()
          if (r.models?.length) models = r.models.map((m) => m.id)
        } catch {
          /* 无 active 账号则忽略 */
        }
      }
      // 拉取失败时保留上次缓存，离线也能用
      if (models.length > 0) {
        setCachedModels(models)
        try {
          localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(models))
        } catch {
          /* ignore */
        }
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const modelOptions = useMemo(
    () => Array.from(new Set([...cachedModels, ...LIVENESS_MODELS])),
    [cachedModels]
  )

  return { model, setModel, modelOptions, cachedCount: cachedModels.length, loading, reload }
}
