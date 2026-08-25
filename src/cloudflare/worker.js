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
import { DurableObject } from 'cloudflare:workers'
import {
  applyEvent, createRoomState, expectedPositionMs, genRoomId, genSecret,
  joinRoom, leaveRoom, publicState, signToken, verifyToken,
  CONTROLLER_OFFLINE_MS, ROOM_AUTO_CLOSE_MS, advanceIfTrackEnded,
} from '../core/protocol.js'
import { probeAudioUrl } from '../core/probe.js'

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
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(request.url)

    if (url.pathname === '/healthz') return json({ ok: true, service: 'neiro-lit' })

    // 密钥零配置：未设置环境变量时自动生成并持久化（重启不丢，跨实例一致）
    let tokenSecret = env.LISTEN_TOGETHER_TOKEN_SECRET
    if (!tokenSecret) {
      tokenSecret = await env.ROOMS.get(env.ROOMS.idFromName('__secret__')).getOrCreateTokenSecret()
    }

    const m = url.pathname.match(/^\/api\/rooms\/(\d{6})(\/(ws|state|join|leave|control|kick))?$/)
    if (!m && url.pathname !== '/api/rooms') return err('not found', 404)

    // 创建房间
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return err('method not allowed', 405)
      const body = await request.json().catch(() => ({}))
      const nickname = String(body.nickname || '')
      const roomName = String(body.roomName || '').trim().slice(0, 30)
      if (!nickname) return err('缺少昵称')
      let roomId = ''
      for (let i = 0; i < 8; i++) {
        const candidate = genRoomId()
        const stub = env.ROOMS.get(env.ROOMS.idFromName(candidate))
        const exists = await stub.roomExists().catch(() => false)
        if (!exists) { roomId = candidate; break }
      }
      if (!roomId) return err('房间号分配失败，请重试', 503)
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId))
      return stub.handleCreate({ nickname, roomName, tokenSecret })
    }

    const roomId = m[1].toUpperCase()
    const action = m[3]
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId))

    if (action === 'ws') {
      const auth = await verifyToken(tokenSecret, url.searchParams.get('token'))
      if (!auth || auth.roomId !== roomId) return err('token 无效', 401)
      // WebSocket 升级必须转发原始请求（WebSocketPair 无法跨 RPC 边界传递）
      const fwd = new URL(url)
      fwd.pathname = '/ws'
      fwd.searchParams.set('memberId', auth.memberId)
      return stub.fetch(fwd.toString())
    }

    const auth = await verifyToken(tokenSecret, bearerToken(request, url))
    if ((action === 'state' || action === 'control' || action === 'leave') &&
        (!auth || auth.roomId !== roomId)) return err('token 无效', 401)

    if (action === 'join' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      return stub.handleJoin({
        nickname: String(body.nickname || ''),
        secret: String(body.secret || ''),
        tokenSecret,
      })
    }
    if (action === 'state' && request.method === 'GET') return stub.handleState(auth.memberId)
    if (action === 'control' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      return stub.handleControl(auth.memberId, body.event || body)
    }
    if (action === 'kick' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      return stub.kickMember(auth.memberId, String(body.targetId || ''))
    }
    if (action === 'leave' && request.method === 'POST') return stub.handleLeave(auth.memberId)

    return err('not found', 404)
  },
}

/** 每个房间一个 Durable Object：持久化房态 + WebSocket 广播。 */
export class ListeningRoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
    this.room = null // 惰性加载
  }

  async load() {
    if (this.room !== null) return this.room
    this.room = (await this.ctx.storage.get('state')) || null
    return this.room
  }

  async save() {
    await this.ctx.storage.put('state', this.room)
  }

  /** 房间是否已被创建过。 */
  async roomExists() {
    return (await this.load()) !== null
  }

  /** 密钥零配置：专用 DO 实例持久化全局 Token 密钥。 */
  async getOrCreateTokenSecret() {
    let secret = await this.ctx.storage.get('tokenSecret')
    if (!secret) {
      secret = genSecret() + genSecret() + Date.now().toString(36)
      await this.ctx.storage.put('tokenSecret', secret)
    }
    return secret
  }

  response(data, status = 200) { return json(data, status) }

  async handleCreate({ nickname, roomName, tokenSecret }) {
    if (await this.load()) return err('房间已存在')
    const nowMs = Date.now()
    const hostMemberId = 'm' + genSecret().slice(0, 12).toLowerCase()
    const joinSecret = genSecret()
    const memberSecret = genSecret()
    const state = createRoomState({ roomId: '', hostMemberId, nickname, nowMs })
    state.roomId = this.ctx.id.name || ''
    if (roomName) state.roomName = roomName
    state.joinSecret = joinSecret
    state.members[hostMemberId].memberSecret = memberSecret
    this.room = state
    await this.save()
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
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

  /** WebSocket 升级（由 Worker 经 stub.fetch 转发进来）。 */
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/ws') return err('not found', 404)
    const memberId = url.searchParams.get('memberId') || ''
    const room = await this.load()
    if (!room || room.closed || !room.members[memberId]) return err('房间不可用', 404)
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [memberId])
    pair[1].send(JSON.stringify({
      type: 'welcome',
      memberId,
      state: publicState(room, Date.now()),
    }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

async handleState(memberId) {
    const room = await this.load()
    if (!room || room.closed) return err('房间不存在或已关闭', 404)
    const m0 = room.members[memberId]
    if (!m0) return err('你已被移出房间', 403)
    // 轮询即心跳：刷新请求者在线状态（修复纯轮询客户端被误标离线）
    m0.lastSeenMs = Date.now()
    await this.save()
    return this.response({ ok: true, state: publicState(room, Date.now()) })
  }

  async handleControl(memberId, evt) {
    const room = await this.load()
    if (!room || room.closed) return err('房间不存在或已关闭', 404)
    if (!room.members[memberId]) return err('你已被移出房间', 403)
    // URL 加歌：先探测可用性（确保传上去就能播），失败拒绝并给出原因
    if (evt?.type === 'ADD_SONG' && evt.track?.sourceId === 'url') {
      const probe = await probeAudioUrl(evt.track.url)
      if (!probe.ok) return err(`URL 不可用：${probe.reason}`, 422)
    }
    const r = applyEvent(room, memberId, evt, Date.now())
    if (!r.ok) return err(r.error, 409)
    await this.save()
    await this.broadcast()
    return this.response({ ok: true, state: publicState(room, Date.now()) })
  }
  /** 房主踢人。 */
  async kickMember(hostMemberId, targetId) {
    const room = await this.load()
    if (!room || room.closed) return err('房间不存在或已关闭', 404)
    if (room.members[hostMemberId]?.role !== 'controller') return err('仅房主可操作', 403)
    const evt = { type: 'KICK', targetId }
    const r = applyEvent(room, hostMemberId, evt, Date.now())
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
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.room = null
      return this.response({ ok: true, closed: true })
    }
    await this.broadcast()
    return this.response({ ok: true, closed: false })
  }

  /** 向所有在线成员广播最新权威房态。 */
  async broadcast() {
    const room = await this.load()
    if (!room) return
    const msg = JSON.stringify({
      type: 'room_state_updated',
      state: publicState(room, Date.now()),
    })
    for (const ws of this.ctx.getWebSockets()) ws.send(msg)
  }

  async closeAll(reason) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, reason) } catch { /* 已关闭 */ }
    }
  }

  // ---- WebSocket Hibernation 回调 ----
  async webSocketMessage(ws, message) {
    const room = await this.load()
    if (!room || room.closed) { ws.close(1000, '房间已关闭'); return }
    let data
    try { data = JSON.parse(message) } catch { return }
    const tags = this.ctx.getTags(ws)
    const memberId = tags[0]
    const m = room.members[memberId]
    if (data.type === 'np_ping') {
      ws.send(JSON.stringify({ type: 'np_pong', nowMs: Date.now() }))
      if (m) { m.lastSeenMs = Date.now(); await this.save() }
      return
    }
    if (data.type === 'event' && data.event) {
      // URL 加歌：先探测可用性
      if (data.event.type === 'ADD_SONG' && data.event.track?.sourceId === 'url') {
        const probe = await probeAudioUrl(data.event.track.url)
        if (!probe.ok) {
          ws.send(JSON.stringify({ type: 'event_rejected', error: `URL 不可用：${probe.reason}` }))
          return
        }
      }
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
  /**
   * 定时器：全员离线检测与自动关房。
   * 房间存活条件 = 有成员在线；房主离线超过 ROOM_AUTO_CLOSE_MS 或全员离线 → 关房。
   */
  async alarm() {
    const room = await this.load()
    if (!room || room.closed) return
    const nowMs = Date.now()
    const anyOnline = Object.values(room.members)
      .some((x) => nowMs - x.lastSeenMs < CONTROLLER_OFFLINE_MS)
    if (anyOnline) {
      delete room.controllerOfflineSinceMs
      await this.ctx.storage.setAlarm(nowMs + 30_000)
      await this.save()
      return
    }
    // 全员离线：记录起点，超过宽限期自动关房释放存储
    room.controllerOfflineSinceMs ??= nowMs
    await this.save()
    if (nowMs - room.controllerOfflineSinceMs >= ROOM_AUTO_CLOSE_MS) {
      room.closed = true
      await this.save()
      await this.closeAll('房间长时间无人，已自动关闭')
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.room = null
      return
    }
    await this.ctx.storage.setAlarm(nowMs + 30_000)
  }
}