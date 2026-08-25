/**
 * Neiro-LIT · Vercel API 共享逻辑（Serverless Functions，Node.js 运行时）
 *
 * 同步模型：无长连接，客户端轮询 GET state（建议 3s）。
 * 房态变更通过 version 字段做乐观更新检测；控制走 POST control（CAS 写入）。
 */
import {
  applyEvent, createRoomState, genRoomId, genSecret,
  joinRoom, leaveRoom, publicState, signToken, verifyToken,
  CONTROLLER_OFFLINE_MS, ROOM_AUTO_CLOSE_MS, advanceIfTrackEnded,
} from '../../core/protocol.js'
import { probeAudioUrl } from '../../core/probe.js'
import { RoomStore } from '../store.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
export const err = (message, status = 400) => json({ ok: false, error: message }, status)

function store() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('未配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN')
  return new RoomStore(url, token)
}
const tokenSecret = () => {
  const s = process.env.LISTEN_TOGETHER_TOKEN_SECRET
  if (!s) throw new Error('未配置 LISTEN_TOGETHER_TOKEN_SECRET')
  return s
}

export function bearerToken(request, url) {
  const h = request.headers.get('Authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token')
}

async function readBody(request) {
  try { return await request.json() } catch { return {} }
}

// ---------- 路由处理 ----------

export async function handleCreateRoom(request) {
  const body = await readBody(request)
  const nickname = String(body.nickname || '')
  const roomName = String(body.roomName || '').trim().slice(0, 30)
  if (!nickname) return err('缺少昵称')
  const nowMs = Date.now()
  for (let i = 0; i < 8; i++) {
    const roomId = genRoomId()
    let result
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await store().update(roomId, (old) => {
        if (old) return null // 已存在，换号重试
        const hostMemberId = `m${genSecret().slice(0, 12).toLowerCase()}`
        const s = createRoomState({ roomId, hostMemberId, nickname, nowMs })
        if (roomName) s.roomName = roomName
        s.joinSecret = genSecret()
        s.members[hostMemberId].memberSecret = genSecret()
        s._created = { joinSecret: s.joinSecret, memberSecret: s.members[hostMemberId].memberSecret }
        return s
      })
    } catch (e) {
      return err(e.message, 500)
    }
    if (result.unchanged) continue // 房间已存在 → 换一个房间号
    const s = result.state
    const memberId = Object.keys(s.members)[0]
    const { joinSecret, memberSecret } = s._created
    delete s._created
    // 把 _created 拆出去后需要再存一次；直接复用 CAS：version 未变则成功
    await store().update(roomId, (old) => (old && old.version === s.version ? s : null))
    const token = await signToken(tokenSecret(), roomId, memberId, nowMs)
    return json({
      ok: true, roomId, memberId, role: 'controller',
      joinSecret, memberSecret, token,
      state: publicState(s, Date.now()),
    })
  }
  return err('房间号分配失败，请重试', 503)
}

export async function handleJoin(request, roomId) {
  const body = await readBody(request)
  const nowMs = Date.now()
  let out = null
  try {
    await store().update(roomId.toUpperCase(), (old) => {
      if (!old || old.closed) { out = { error: '房间不存在或已关闭', code: 404 }; return null }
      const r = joinRoom(old, { nickname: String(body.nickname || ''), secret: String(body.secret || '') }, nowMs)
      if (!r.ok) { out = { error: r.error, code: 403 }; return null }
      const isNew = !r.reconnect
      let memberSecret = old.members[r.memberId] ? old.members[r.memberId].memberSecret : null
      if (isNew) {
        memberSecret = genSecret()
        r.state.members[r.memberId].memberSecret = memberSecret
      }
      out = { ok: true, state: r.state, memberId: r.memberId, reconnect: r.reconnect, memberSecret }
      return r.state
    })
  } catch (e) {
    return err(e.message, 500)
  }
  if (!out) return err('并发冲突，请重试', 503)
  if (out.error) return err(out.error, out.code)
  const token = await signToken(tokenSecret(), out.state.roomId, out.memberId, nowMs)
  return json({
    ok: true,
    roomId: out.state.roomId,
    memberId: out.memberId,
    role: out.state.members[out.memberId].role,
    reconnect: out.reconnect,
    memberSecret: out.memberSecret,
    token,
    state: publicState(out.state, Date.now()),
  })
}

export async function handleState(roomId, auth) {
  const id = roomId.toUpperCase()
  const nowMs = Date.now()
  const room = await store().get(id)
  if (!room || room.closed) return err('房间不存在或已关闭', 404)
  if (auth?.memberId && room.members[auth.memberId]) {
    // 轮询即心跳：原子刷新请求者在线状态（修复纯轮询客户端被误标离线）
    await store().update(id, (old) => {
      if (!old || !old.members[auth.memberId]) return null
      old.members[auth.memberId].lastSeenMs = nowMs
      return old
    })
    return json({ ok: true, version: room.version, state: publicState(room, nowMs) })
  }
  // 惰性自动关房：Serverless 无常驻定时器，靠请求路径触发。
  // 全员离线且最后活动距今超过宽限期 → 删除房间（URL 随房销毁）。
  const anyOnline = Object.values(room.members)
    .some((m) => nowMs - (m.lastSeenMs || 0) < CONTROLLER_OFFLINE_MS)
  const lastActivity = Math.max(...Object.values(room.members).map((m) => m.lastSeenMs || 0))
  if (!anyOnline && nowMs - lastActivity >= ROOM_AUTO_CLOSE_MS) {
    await store().delete(id)
    return err('房间长时间无人，已自动关闭', 404)
  }
  return json({ ok: true, version: room.version, state: publicState(room, nowMs) })
}

export async function handleControl(request, roomId, auth) {
  const body = await readBody(request)
  const evt = body.event || body
  // URL 加歌：先探测可用性（确保传上去就能播），失败拒绝并给出原因
  if (evt?.type === 'ADD_SONG' && evt.track?.sourceId === 'url') {
    const probe = await probeAudioUrl(evt.track.url)
    if (!probe.ok) return err(`URL 不可用：${probe.reason}`, 422)
  }
  const nowMs = Date.now()
  let out = null
  try {
    await store().update(roomId.toUpperCase(), (old) => {
      if (!old || old.closed) { out = { error: '房间不存在或已关闭', code: 404 }; return null }
      const r = applyEvent(old, auth.memberId, evt, nowMs)
      if (!r.ok) { out = { error: r.error, code: 409 }; return null }
      out = { ok: true, state: old }
      return old
    })
  } catch (e) {
    return err(e.message, 500)
  }
  if (!out) return err('并发冲突，请重试', 503)
  if (out.error) return err(out.error, out.code)
  return json({ ok: true, state: publicState(out.state, Date.now()) })
}

export async function handleLeave(roomId, auth) {
  const nowMs = Date.now()
  let out = null
  try {
    await store().update(roomId.toUpperCase(), (old) => {
      if (!old) { out = { error: '房间不存在', code: 404 }; return null }
      const r = leaveRoom(old, auth.memberId, nowMs)
      if (!r.ok) { out = { error: r.error, code: 403 }; return null }
      out = { ok: true, closed: r.closed }
      return r.closed ? null : old // 房主离开 → 删除键
    })
  } catch (e) {
    return err(e.message, 500)
  }
  if (!out) return err('并发冲突，请重试', 503)
  if (out.error) return err(out.error, out.code)
  return json({ ok: true, closed: out.closed })
}

export async function verifyAuth(roomId, request, url) {
  return verifyToken(tokenSecret(), bearerToken(request, url))
}
/** 房主踢人。 */
export async function handleKick(request, roomId, auth) {
  const body = await readBody(request)
  const targetId = String(body.targetId || '')
  const nowMs = Date.now()
  const id = roomId.toUpperCase()
  let out = null
  try {
    await store().update(id, (old) => {
      if (!old || old.closed) { out = { error: '房间不存在或已关闭', code: 404 }; return null }
      if (old.members[auth.memberId]?.role !== 'controller') {
        out = { error: '仅房主可操作', code: 403 }; return null
      }
      const r = applyEvent(old, auth.memberId, { type: 'KICK', targetId }, nowMs)
      if (!r.ok) { out = { error: r.error, code: 409 }; return null }
      out = { ok: true, state: old }
      return old
    })
  } catch (e) {
    return err(e.message, 500)
  }
  if (!out) return err('并发冲突，请重试', 503)
  if (out.error) return err(out.error, out.code)
  return json({ ok: true, state: publicState(out.state, Date.now()) })
}
