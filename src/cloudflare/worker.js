/**
 * Neiro-LIT · Cloudflare Workers 服务端
 *
 * 运行时：Workers + Durable Objects（每房间一实例）+ WebSocket Hibernation。
 * 部署：wrangler deploy（见 wrangler.toml），需配置环境变量 LISTEN_TOGETHER_TOKEN_SECRET。
 *
 * HTTP API：
 *   POST   /api/rooms                     创建房间 {nickname}
 *   POST   /api/rooms/:id/join            加入 {nickname, secret}
 *   GET    /api/rooms/:id/state           快照（Bearer Token）
 *   POST   /api/rooms/:id/control         控制事件（Bearer Token）
 *   POST   /api/rooms/:id/leave           显式离开（Bearer Token）
 *   GET    /api/rooms/:id/ws?token=...    WebSocket 实时同步
 *   GET    /healthz                       健康检查
 */
import {
  applyEvent, createRoomState, expectedPositionMs, genRoomId, genSecret,
  joinRoom, leaveRoom, publicState, signToken, verifyToken,
} from '../core/protocol.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
})
const err = (message, status = 400) => json({ ok: false, error: message }, status)

/** 从 Authorization 头或查询参数取 Bearer Token。 */
function bearerToken(request, url) {
  const h = request.headers.get('Authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token')
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(request.url)

    if (url.pathname === '/healthz') return json({ ok: true, service: 'neiro-lit' })
    if (!env.LISTEN_TOGETHER_TOKEN_SECRET) {
      return err('服务端未配置 LISTEN_TOGETHER_TOKEN_SECRET', 500)
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(\/(ws|state|join|leave|control))?$/)
    if (!m && url.pathname !== '/api/rooms') return err('not found', 404)

    // 创建房间
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return err('method not allowed', 405)
      const body = await request.json().catch(() => ({}))
      const nickname = String(body.nickname || '')
      if (!nickname) return err('缺少昵称')
      let roomId = ''
      for (let i = 0; i < 8; i++) {
        const candidate = genRoomId()
        const probe = await env.ROOMS.idFromName(candidate)
        const stub = env.ROOMS.get(probe)
        const exists = await stub.roomExists().catch(() => false)
        if (!exists) { roomId = candidate; break }
      }
      if (!roomId) return err('房间号分配失败，请重试', 503)
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId))
      return stub.handleCreate({ nickname, tokenSecret: env.LISTEN_TOGETHER_TOKEN_SECRET })
    }

    const roomId = m[1].toUpperCase()
    const action = m[3]
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId))

    if (action === 'ws') {
      const auth = await verifyToken(env.LISTEN_TOGETHER_TOKEN_SECRET, url.searchParams.get('token'))
      if (!auth || auth.roomId !== roomId) return err('token 无效', 401)
      return stub.handleWs(auth.memberId)
    }

    const auth = await verifyToken(env.LISTEN_TOGETHER_TOKEN_SECRET, bearerToken(request, url))
    if ((action === 'state' || action === 'control' || action === 'leave') &&
        (!auth || auth.roomId !== roomId)) return err('token 无效', 401)

    if (action === 'join' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      return stub.handleJoin({
        nickname: String(body.nickname || ''),
        secret: String(body.secret || ''),
        tokenSecret: env.LISTEN_TOGETHER_TOKEN_SECRET,
      })
    }
    if (action === 'state' && request.method === 'GET') return stub.handleState()
    if (action === 'control' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      return stub.handleControl(auth.memberId, body.event || body)
    }
    if (action === 'leave' && request.method === 'POST') return stub.handleLeave(auth.memberId)

    return err('not found', 404)
  },
}

/** 每个房间一个 Durable Object：持久化房态 + WebSocket 广播。 */
export class ListeningRoomDO {
  constructor(state) {
    this.state = state
    this.room = null // 惰性加载
  }

  async load() {
    if (this.room !== null) return this.room
    this.room = (await this.state.storage.get('state')) || null
    return this.room
  }

  async save() {
    await this.state.storage.put('state', this.room)
  }

  /** 房间是否已被创建过。 */
  async roomExists() {
    return (await this.load()) !== null
  }

  response(data, status = 200) { return json(data, status) }

  async handleCreate({ nickname, tokenSecret }) {
    if (await this.load()) return err('房间已存在')
    const nowMs = Date.now()
    const hostMemberId = 'm' + genSecret().slice(0, 12).toLowerCase()
    const joinSecret = genSecret()
    const memberSecret = genSecret()
    const state = createRoomState({ roomId: '', hostMemberId, nickname, nowMs })
    state.roomId = this.state.id.name || ''
    state.joinSecret = joinSecret
    state.members[hostMemberId].memberSecret = memberSecret
    this.room = state
    await this.save()
    await this.state.storage.setAlarm(Date.now() + 60_000)
    const token = await signToken(tokenSecret, state.roomId, hostMemberId, nowMs)
    return this.response({
      ok: true,
      roomId: state.roomId,
      memberId: hostMemberId,
      role: 'controller',
      joinSecret,
      memberSecret,
      token,
      state: publicState(state, nowMs),
    })
  }

  async handleJoin({ nickname, secret, tokenSecret }) {
    const room = await this.load()
    if (!room) return err('房间不存在', 404)
    const nowMs = Date.now()
    const r = joinRoom(room, { nickname, secret }, nowMs)
    if (!r.ok) return err(r.error, 403)
    let memberSecret = r.state.members[r.memberId].memberSecret
    const isNew = !r.reconnect
    if (isNew) {
      memberSecret = genSecret()
      r.state.members[r.memberId].memberSecret = memberSecret
    }
    await this.save()
    const token = await signToken(tokenSecret, room.roomId, r.memberId, nowMs)
    if (isNew || r.pausedByJoin) await this.broadcast()
    return this.response({
      ok: true,
      roomId: room.roomId,
      memberId: r.memberId,
      role: r.state.members[r.memberId].role,
      reconnect: r.reconnect,
      memberSecret,
      token,
      state: publicState(r.state, nowMs),
    })
  }

  async handleState() {
    const room = await this.load()
    if (!room || room.closed) return err('房间不存在或已关闭', 404)
    return this.response({ ok: true, state: publicState(room, Date.now()) })
  }

  async handleControl(memberId, evt) {
    const room = await this.load()
    if (!room || room.closed) return err('房间不存在或已关闭', 404)
    const r = applyEvent(room, memberId, evt, Date.now())
    if (!r.ok) return err(r.error, 409)
    await this.save()
    await this.broadcast()
    return this.response({ ok: true, state: publicState(room, Date.now()) })
  }

  async handleLeave(memberId) {
    const room = await this.load()
    if (!room) return err('房间不存在', 404)
    const r = leaveRoom(room, memberId, Date.now())
    if (!r.ok) return err(r.error, 403)
    await this.save()
    if (r.closed) {
      await this.closeAll('房主已离开，房间关闭')
      await this.state.storage.deleteAlarm()
      await this.state.storage.deleteAll()
      this.room = null
      return this.response({ ok: true, closed: true })
    }
    await this.broadcast()
    return this.response({ ok: true, closed: false })
  }

  async handleWs(memberId) {
    const room = await this.load()
    if (!room || room.closed || !room.members[memberId]) return err('房间不可用', 404)
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1], [memberId])
    pair[1].send(JSON.stringify({
      type: 'welcome',
      memberId,
      state: publicState(room, Date.now()),
    }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** 向所有在线成员广播最新权威房态。 */
  async broadcast() {
    const room = await this.load()
    if (!room) return
    const msg = JSON.stringify({
      type: 'room_state_updated',
      state: publicState(room, Date.now()),
    })
    for (const ws of this.state.getWebSockets()) ws.send(msg)
  }

  async closeAll(reason) {
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, reason) } catch { /* 已关闭 */ }
    }
  }

  // ---- WebSocket Hibernation 回调 ----
  async webSocketMessage(ws, message) {
    const room = await this.load()
    if (!room || room.closed) { ws.close(1000, '房间已关闭'); return }
    let data
    try { data = JSON.parse(message) } catch { return }
    const tags = this.state.getTags(ws)
    const memberId = tags[0]
    if (data.type === 'np_ping') {
      ws.send(JSON.stringify({ type: 'np_pong', nowMs: Date.now() }))
      const m = room.members[memberId]
      if (m) m.lastSeenMs = Date.now()
      await this.save()
      return
    }
    if (data.type === 'event' && data.event) {
      const r = applyEvent(room, memberId, data.event, Date.now())
      if (r.ok) {
        await this.save()
        await this.broadcast()
      } else {
        ws.send(JSON.stringify({ type: 'event_rejected', error: r.error }))
      }
    }
  }

  async webSocketClose() { /* 成员保留以支持重连 */ }

  /** 定时器：控制者离线检测与自动关房。 */
  async alarm() {
    const room = await this.load()
    if (!room || room.closed) return
    const nowMs = Date.now()
    const c = room.members[room.controllerId]
    if (c && (nowMs - c.lastSeenMs) >= 45_000) {
      room.controllerOfflineSinceMs ??= c.lastSeenMs
    } else {
      delete room.controllerOfflineSinceMs
    }
    await this.save()
    if (room.controllerOfflineSinceMs &&
        nowMs - room.controllerOfflineSinceMs > 600_000) {
      room.closed = true
      await this.save()
      await this.broadcast()
      await this.closeAll('房主长时间离线，自动关房')
      await this.state.storage.deleteAll()
      this.room = null
      return
    }
    await this.broadcast() // 让听众知道房主离线状态变化
    await this.state.storage.setAlarm(nowMs + 30_000)
  }
}