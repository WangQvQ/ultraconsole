import {
  apiGetWebhook,
  apiSelectEngine,
  apiSetWebhook,
  apiUpdateParams,
  type WebhookConfig,
} from '../api/client'
import {
  useConsoleStore,
  type AlertConfig,
  type DeviceType,
  type EventsConfig,
  type OSDFlags,
  type Params,
  type RoiState,
} from '../store/useConsoleStore'

const VERSION = '1.0'

export type FullConfig = {
  version: string
  exportedAt: string
  app: 'ultraconsole'
  // 服务端
  params: Params
  engine: { device: DeviceType }
  modelId?: string
  webhook?: WebhookConfig
  // 客户端
  osd: OSDFlags
  roi: RoiState
  alertConfig: AlertConfig
  eventsConfig: EventsConfig
}

/** 收集当前完整配置（含从后端 fetch 的 webhook） */
export async function collectConfig(): Promise<FullConfig> {
  const s = useConsoleStore.getState()
  let webhook: WebhookConfig | undefined
  try {
    webhook = await apiGetWebhook()
  } catch {
    webhook = undefined
  }
  return {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: 'ultraconsole',
    params: s.params,
    engine: { device: s.engine.device },
    modelId: s.currentModelId,
    webhook,
    osd: s.osd,
    roi: s.roi,
    alertConfig: s.alertConfig,
    eventsConfig: s.eventsConfig,
  }
}

/** 触发浏览器下载 JSON */
export async function exportConfigDownload(filename = `ultraconsole-config-${Date.now()}.json`) {
  const cfg = await collectConfig()
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return cfg
}

export type ApplyResult = {
  ok: boolean
  applied: string[]
  errors: { key: string; reason: string }[]
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

/** 应用导入的配置：客户端立即生效，服务端配置异步 POST */
export async function applyConfig(json: unknown): Promise<ApplyResult> {
  const errors: { key: string; reason: string }[] = []
  const applied: string[] = []

  if (!isObj(json)) {
    return { ok: false, applied, errors: [{ key: 'root', reason: 'not a config object' }] }
  }
  if (json.app !== 'ultraconsole') {
    errors.push({ key: 'app', reason: `unexpected app=${json.app}` })
  }

  const store = useConsoleStore.getState()

  // 客户端：osd / roi / alertConfig / eventsConfig
  if (isObj(json.osd)) {
    store.setOSD(json.osd as Partial<OSDFlags>)
    applied.push('osd')
  }
  if (isObj(json.roi)) {
    store.setRoi(json.roi as Partial<RoiState>)
    applied.push('roi')
  }
  if (isObj(json.alertConfig)) {
    store.setAlertConfig(json.alertConfig as Partial<AlertConfig>)
    applied.push('alertConfig')
  }
  if (isObj(json.eventsConfig)) {
    store.setEventsConfig(json.eventsConfig as Partial<EventsConfig>)
    applied.push('eventsConfig')
  }

  // 服务端：params
  if (isObj(json.params)) {
    const p = json.params as Partial<Params>
    const next: Params = {
      conf: typeof p.conf === 'number' ? p.conf : store.params.conf,
      iou: typeof p.iou === 'number' ? p.iou : store.params.iou,
      classFilter: Array.isArray(p.classFilter) ? (p.classFilter as string[]) : store.params.classFilter,
      track: typeof p.track === 'boolean' ? p.track : store.params.track,
    }
    store.setParams(next)
    try {
      await apiUpdateParams(next)
      applied.push('params')
    } catch (e) {
      errors.push({ key: 'params', reason: String(e) })
    }
  }

  // 服务端：engine.device
  if (isObj(json.engine) && (json.engine as { device?: unknown }).device) {
    const dev = (json.engine as { device?: DeviceType }).device
    if (dev === 'cpu' || dev === 'cuda') {
      try {
        await apiSelectEngine(dev)
        store.setEngine({ device: dev })
        applied.push('engine.device')
      } catch (e) {
        errors.push({ key: 'engine.device', reason: String(e) })
      }
    }
  }

  // 服务端：webhook
  if (isObj(json.webhook)) {
    try {
      await apiSetWebhook(json.webhook as WebhookConfig)
      applied.push('webhook')
    } catch (e) {
      errors.push({ key: 'webhook', reason: String(e) })
    }
  }

  return { ok: errors.length === 0, applied, errors }
}
