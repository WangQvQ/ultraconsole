/**
 * 带自动重连 + 心跳的 WebSocket 包装。
 *
 * 用法：
 *   const ws = createReconnectingWs({
 *     url: wsStreamUrl(),
 *     onOpen: () => ws.send(JSON.stringify({type:'rtsp.start', ...})),
 *     onMessage: (data) => {...},
 *     onState: (state, info) => {...},
 *   })
 *   ws.send(...)         // 内部缓冲，断开期间会丢弃（只发文本/JSON）
 *   ws.close()           // 显式关闭，不再重连
 *
 * 行为：
 *   - 断开后按指数退避重连（1s,2s,4s,8s 上限 15s），无限次
 *   - 每 15s 发 {type:'ping'}；30s 内未收到 {type:'pong'} 视为超时，强制断开 → 重连
 *   - 每次重连后 onOpen 会再次触发，便于上层重发 rtsp.start 等初始化消息
 */

export type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting'

export type ReconnectingWsOpts = {
  url: string
  onOpen?: () => void
  onMessage?: (data: unknown, raw: MessageEvent) => void
  onState?: (state: WsState, info?: { attempt?: number; reason?: string }) => void
  pingIntervalMs?: number
  pongTimeoutMs?: number
  maxBackoffMs?: number
  initialBackoffMs?: number
}

export type ReconnectingWs = {
  send: (data: string) => boolean
  close: () => void
  state: () => WsState
  bufferedAmount: () => number
  readyState: () => number | null
}

export function createReconnectingWs(opts: ReconnectingWsOpts): ReconnectingWs {
  const {
    url,
    onOpen,
    onMessage,
    onState,
    pingIntervalMs = 15_000,
    pongTimeoutMs = 30_000,
    maxBackoffMs = 15_000,
    initialBackoffMs = 1_000,
  } = opts

  let ws: WebSocket | null = null
  let attempt = 0
  let stopped = false
  let pingTimer: number | null = null
  let pongTimer: number | null = null
  let reconnectTimer: number | null = null
  let curState: WsState = 'idle'

  const setState = (s: WsState, info?: { attempt?: number; reason?: string }) => {
    curState = s
    onState?.(s, info)
  }

  const clearTimers = () => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer)
      pingTimer = null
    }
    if (pongTimer !== null) {
      window.clearTimeout(pongTimer)
      pongTimer = null
    }
  }

  const armPongTimeout = () => {
    if (pongTimer !== null) window.clearTimeout(pongTimer)
    pongTimer = window.setTimeout(() => {
      // pong 超时 → 主动断开走重连
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }, pongTimeoutMs)
  }

  const startHeartbeat = () => {
    clearTimers()
    armPongTimeout()
    pingTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() / 1000 }))
        } catch {
          // ignore
        }
        armPongTimeout()
      }
    }, pingIntervalMs)
  }

  const scheduleReconnect = () => {
    if (stopped) return
    const backoff = Math.min(initialBackoffMs * Math.pow(2, attempt), maxBackoffMs)
    setState('reconnecting', { attempt: attempt + 1 })
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      attempt += 1
      connect()
    }, backoff)
  }

  const connect = () => {
    if (stopped) return
    setState('connecting', { attempt })
    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch (e) {
      setState('error', { reason: String(e) })
      scheduleReconnect()
      return
    }
    ws = sock

    sock.onopen = () => {
      attempt = 0
      setState('open')
      startHeartbeat()
      try {
        onOpen?.()
      } catch {
        // ignore
      }
    }

    sock.onclose = (ev) => {
      clearTimers()
      ws = null
      if (stopped) {
        setState('closed', { reason: ev.reason || `code=${ev.code}` })
        return
      }
      setState('closed', { reason: ev.reason || `code=${ev.code}` })
      scheduleReconnect()
    }

    sock.onerror = () => {
      setState('error')
      // onclose 会跟着触发，重连交给 onclose
    }

    sock.onmessage = (ev) => {
      // 解析一次 JSON，便于上层和心跳共用
      let data: unknown = ev.data
      try {
        if (typeof ev.data === 'string') data = JSON.parse(ev.data)
      } catch {
        // 非 JSON 也透传给上层
      }
      // 拦截 pong：刷新超时计时
      if (data && typeof data === 'object' && (data as { type?: string }).type === 'pong') {
        armPongTimeout()
        return
      }
      try {
        onMessage?.(data, ev)
      } catch {
        // ignore
      }
    }
  }

  connect()

  return {
    send: (s: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(s)
          return true
        } catch {
          return false
        }
      }
      return false
    },
    close: () => {
      stopped = true
      clearTimers()
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      try {
        ws?.close()
      } catch {
        // ignore
      }
      ws = null
      setState('closed', { reason: 'client_close' })
    },
    state: () => curState,
    bufferedAmount: () => ws?.bufferedAmount ?? 0,
    readyState: () => ws?.readyState ?? null,
  }
}
