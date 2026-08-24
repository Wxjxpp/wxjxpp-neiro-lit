/**
 * Neiro-LIT 一起听 · 协议核心（纯逻辑，Cloudflare Workers 与 Vercel 共享）
 *
 * 设计要点（参考 NeriPlayer-LTW 的房态权威模型并做简化）：
 * - 服务端是唯一权威：expectedPositionMs 由 basePositionMs + elapsed*rate 推算，
 *   客户端永远以服务端快照为准校正本地进度，不信任对端上报的进度。
 * - 双角色：controller（房主）可发控制事件；listener 只能发 REQUEST_*（受
 *   allowMemberControl 门控，且必须携带与当前曲目匹配的 stableKey 防误切）。
 * - 身份：房间有 joinSecret（邀请首次入房）；成员有 memberSecret（重连）；
 *   访问凭据是 HMAC 签名的 Token（24h）。密钥绝不出现在脱敏快照中。
 * - 本地歌曲（sourceId === 'local'）禁止入房同步。
 */

export const ROOM_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const ROOM_ID_LENGTH = 6
export const QUEUE_LIMIT = 2000
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** 控制者超过该时长无心跳视为离线。 */
export const CONTROLLER_OFFLINE_MS = 45 * 1000
/** 控制者离线超过该时长自动关房（释放存储）。 */
export const ROOM_AUTO_CLOSE_MS = 10 * 60 * 1000
export const NICKNAME_MAX = 24

export const CONTROL_EVENTS = new Set([
  'PLAY', 'PAUSE', 'SEEK', 'PLAYBACK_MODE', 'SET_TRACK', 'SET_QUEUE',
  'HEARTBEAT', 'UPDATE_SETTINGS',
])
export const REQUEST_EVENTS = new Set([
  'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK',
  'REQUEST_PLAYBACK_MODE', 'REQUEST_SET_TRACK', 'REQUEST_SET_QUEUE',
])
const MEMBER_CONTROLLED = new Set([
  'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK', 'REQUEST_PLAYBACK_MODE',
])

export function genRoomId(random = Math.random) {
  let s = ''
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    s += ROOM_ID_ALPHABET[Math.floor(random() * ROOM_ID_ALPHABET.length)]
  }
  return s
}

export function genSecret(random = Math.random) {
  // 128bit 等价的可读密钥（22 字符 base36 混合）
  let s = ''
  for (let i = 0; i < 26; i++) {
    s += ROOM_ID_ALPHABET[Math.floor(random() * ROOM_ID_ALPHABET.length)]
  }
  return s
}

/** 昵称：1-24 个中文 / 英文字母 / 数字。 */
export function validNickname(nickname) {
  return typeof nickname === 'string' &&
    nickname.length >= 1 && nickname.length <= NICKNAME_MAX &&
    /^[\p{Script=Han}A-Za-z0-9]+$/u.test(nickname)
}

/** 曲目稳定键：跨端匹配同一首歌的唯一依据。 */
export function stableKeyOf(track) {
  return `${track.sourceId}:${track.songId}`
}

export function validTrack(track) {
  return !!track &&
    typeof track.songId === 'string' && track.songId.length > 0 &&
    typeof track.sourceId === 'string' && track.sourceId.length > 0 &&
    track.sourceId !== 'local' &&
    typeof track.title === 'string' && track.title.length <= 200 &&
    Number.isFinite(track.durationMs) && track.durationMs >= 0
}

function sanitizeTrack(t) {
  return {
    stableKey: stableKeyOf(t),
    songId: String(t.songId),
    sourceId: String(t.sourceId),
    title: String(t.title).slice(0, 200),
    artist: String(t.artist ?? '').slice(0, 200),
    album: String(t.album ?? '').slice(0, 200),
    durationMs: Math.max(0, Math.round(t.durationMs || 0)),
    cover: typeof t.cover === 'string' ? t.cover.slice(0, 500) : '',
  }
}

export function createRoomState({ roomId, hostMemberId, nickname, nowMs }) {
  return {
    schemaVersion: 1,
    roomId,
    version: 1,
    createdAt: nowMs,
    controllerId: hostMemberId,
    closed: false,
    joinSecret: null, // 由调用方注入后落盘；脱敏时剔除
    members: {
      [hostMemberId]: {
        memberId: hostMemberId, nickname,
        role: 'controller', joinedAt: nowMs, lastSeenMs: nowMs,
        memberSecret: null, seq: 0,
      },
    },
    playback: {
      track: null, queue: [], currentIndex: -1,
      playing: false, basePositionMs: 0, anchoredAtMs: nowMs, rate: 1,
      repeatMode: 2, shuffleEnabled: false,
    },
    settings: { allowMemberControl: true, autoPauseOnMemberChange: true },
  }
}

/** 加入成员（含重连识别）。返回 {ok, state, memberId, reconnect} 或 {ok:false, error}。 */
export function joinRoom(state, { nickname, secret }, nowMs) {
  if (state.closed) return { ok: false, error: '房间已关闭' }
  // 重连：memberSecret 匹配已有成员
  for (const m of Object.values(state.members)) {
    if (m.memberSecret && secret && m.memberSecret === secret) {
      m.lastSeenMs = nowMs
      state.version++
      return { ok: true, state, memberId: m.memberId, reconnect: true }
    }
  }
  if (!validNickname(nickname)) return { ok: false, error: '昵称不合法（1-24 位中文/字母/数字）' }
  if (!state.joinSecret || secret !== state.joinSecret) return { ok: false, error: '邀请密钥错误' }
  if (Object.keys(state.members).length >= 50) return { ok: false, error: '房间人数已满' }
  const memberId = 'm' + genSecret().slice(0, 12).toLowerCase()
  state.members[memberId] = {
    memberId, nickname, role: 'listener',
    joinedAt: nowMs, lastSeenMs: nowMs, memberSecret: null, seq: 0,
  }
  const autoPause = state.settings.autoPauseOnMemberChange &&
    state.playback.playing && state.playback.track
  if (autoPause) anchorPause(state, nowMs)
  state.version++
  return { ok: true, state, memberId, reconnect: false, pausedByJoin: autoPause }
}

export function leaveRoom(state, memberId, nowMs) {
  const m = state.members[memberId]
  if (!m) return { ok: false, error: '不是房间成员' }
  delete state.members[memberId]
  let paused = false
  if (m.role !== 'controller' && state.settings.autoPauseOnMemberChange &&
      state.playback.playing && state.playback.track) {
    anchorPause(state, nowMs); paused = true
  }
  if (m.role === 'controller') state.closed = true
  state.version++
  return { ok: true, state, paused, closed: m.role === 'controller' }
}

function anchorPlay(state, positionMs, nowMs) {
  const p = state.playback
  p.playing = true
  p.basePositionMs = clampPos(state, positionMs)
  p.anchoredAtMs = nowMs
}
function anchorPause(state, nowMs) {
  const p = state.playback
  p.basePositionMs = expectedPositionMs(state, nowMs)
  p.anchoredAtMs = nowMs
  p.playing = false
}
function clampPos(state, pos) {
  const p = state.playback
  const dur = p.track?.durationMs || 0
  if (dur > 0 && p.repeatMode === 1) return ((pos % dur) + dur) % dur
  return Math.max(0, Math.min(pos, dur > 0 ? dur : pos))
}

/** 服务端权威位置推算：客户端用它 + nowMs 校正本地进度。 */
export function expectedPositionMs(state, nowMs) {
  const p = state.playback
  if (!p.playing || !p.track) return Math.max(0, p.basePositionMs)
  let pos = p.basePositionMs + Math.max(0, nowMs - p.anchoredAtMs) * (p.rate || 1)
  const dur = p.track.durationMs
  if (dur > 0 && p.repeatMode === 1) pos %= dur
  return Math.max(0, Math.floor(pos))
}

function controllerOnline(state, nowMs) {
  const c = state.members[state.controllerId]
  return !!c && (nowMs - c.lastSeenMs) < CONTROLLER_OFFLINE_MS
}

/**
 * 应用一个控制/请求事件（纯函数，直接改写传入 state 并递增 version）。
 * 返回 {ok, reason?} 或 {ok:false, error}。
 */
export function applyEvent(state, actorId, evt, nowMs) {
  if (state.closed) return { ok: false, error: '房间已关闭' }
  const actor = state.members[actorId]
  if (!actor) return { ok: false, error: '不是房间成员' }

  // 幂等/乱序防护：同一成员的事件序号必须递增（HEARTBEAT 除外）
  if (evt.type !== 'HEARTBEAT') {
    const seq = Number(evt.clientSequence)
    if (Number.isFinite(seq)) {
      if (seq <= actor.seq) return { ok: false, error: '过期事件已丢弃' }
      actor.seq = seq
    }
  } else {
    actor.lastSeenMs = nowMs
  }

  const type = evt.type
  if (CONTROL_EVENTS.has(type)) {
    if (actor.role !== 'controller') {
      // 允许听众发心跳/设置以外的控制会被拒绝
      if (type !== 'HEARTBEAT') return { ok: false, error: '只有房主可以控制播放' }
      return { ok: true }
    }
    return applyControl(state, type, evt, nowMs)
  }
  if (REQUEST_EVENTS.has(type)) {
    if (actor.role === 'controller') return applyControl(state, type.slice(8), evt, nowMs)
    if (!state.settings.allowMemberControl) return { ok: false, error: '房主未开启成员控制' }
    if (!controllerOnline(state, nowMs)) return { ok: false, error: '房主不在线' }
    if (MEMBER_CONTROLLED.has(type)) {
      const want = evt.requestTrackStableKey ||
        (evt.track && stableKeyOf(evt.track)) || ''
      const cur = state.playback.track
      if (!cur || want !== cur.stableKey) {
        return { ok: false, error: '目标歌曲已切换，请求被拒绝' }
      }
    }
    return applyControl(state, type.slice(8), evt, nowMs)
  }
  return { ok: false, error: `未知事件类型 ${type}` }
}

function applyControl(state, action, evt, nowMs) {
  const p = state.playback
  switch (action) {
    case 'PLAY': {
      if (!p.track) return { ok: false, error: '房间还没有曲目' }
      anchorPlay(state, Number(evt.positionMs) || expectedPositionMs(state, nowMs), nowMs)
      break
    }
    case 'PAUSE':
      if (p.track) anchorPause(state, nowMs)
      break
    case 'SEEK': {
      if (!p.track) return { ok: false, error: '房间还没有曲目' }
      const pos = Math.max(0, Number(evt.positionMs) || 0)
      if (p.playing) anchorPlay(state, pos, nowMs)
      else { p.basePositionMs = clampPos(state, pos); p.anchoredAtMs = nowMs }
      break
    }
    case 'PLAYBACK_MODE': {
      const rm = Number(evt.repeatMode)
      if (![0, 1, 2].includes(rm)) return { ok: false, error: 'repeatMode 仅接受 0/1/2' }
      // 先按旧语义锚定位置再切换模式，避免单曲循环取模跳变
      const cur = expectedPositionMs(state, nowMs)
      p.repeatMode = rm
      p.shuffleEnabled = !!evt.shuffleEnabled
      if (p.playing) anchorPlay(state, cur, nowMs)
      break
    }
    case 'SET_TRACK': {
      const t = evt.track
      if (!validTrack(t)) return { ok: false, error: '不支持本地歌曲或曲目数据不完整' }
      const idx = Array.isArray(evt.queue)
        ? evt.queue.findIndex((x) => x && stableKeyOf(x) === stableKeyOf(t))
        : p.queue.findIndex((x) => x.stableKey === stableKeyOf(t))
      p.queue = normalizeQueue(evt.queue, p.queue)
      p.currentIndex = idx >= 0 ? idx : p.queue.findIndex(
        (x) => x.stableKey === stableKeyOf(t),
      )
      p.track = sanitizeTrack(t)
      const shouldPlay = evt.shouldPlay === undefined ? true : !!evt.shouldPlay
      p.basePositionMs = Math.max(0, Number(evt.positionMs) || 0)
      p.anchoredAtMs = nowMs
      p.playing = shouldPlay
      break
    }
    case 'SET_QUEUE': {
      if (!Array.isArray(evt.queue) || evt.queue.length === 0) {
        return { ok: false, error: '队列不能为空' }
      }
      if (evt.queue.some((t) => !validTrack(t))) {
        return { ok: false, error: '队列包含本地歌曲或不完整曲目' }
      }
      if (evt.queue.length > QUEUE_LIMIT) return { ok: false, error: '队列超出上限' }
      p.queue = evt.queue.map(sanitizeTrack)
      const ci = Math.max(0, Math.min(Number(evt.currentIndex) || 0, p.queue.length - 1))
      p.currentIndex = ci
      p.track = p.queue[ci]
      p.basePositionMs = Math.max(0, Number(evt.positionMs) || 0)
      p.anchoredAtMs = nowMs
      break
    }
    case 'UPDATE_SETTINGS': {
      const s = evt.settings || {}
      if (typeof s.allowMemberControl === 'boolean') {
        state.settings.allowMemberControl = s.allowMemberControl
      }
      if (typeof s.autoPauseOnMemberChange === 'boolean') {
        state.settings.autoPauseOnMemberChange = s.autoPauseOnMemberChange
      }
      break
    }
    case 'HEARTBEAT':
      break
    default:
      return { ok: false, error: `不支持的操作 ${action}` }
  }
  state.version++
  return { ok: true }
}

function normalizeQueue(incoming, fallback) {
  if (!Array.isArray(incoming) || incoming.length === 0) return fallback
  if (incoming.some((t) => !validTrack(t))) return fallback
  if (incoming.length > QUEUE_LIMIT) return fallback
  return incoming.map(sanitizeTrack)
}

/** 脱敏快照：剔除一切密钥，附上服务端推算位置与时钟。 */
export function publicState(state, nowMs) {
  const { joinSecret, ...rest } = state
  const members = Object.fromEntries(Object.entries(state.members).map(([k, m]) => [
    k, { ...m, memberSecret: undefined, seq: undefined },
  ]))
  return {
    ...rest,
    members,
    serverNowMs: nowMs,
    expectedPositionMs: expectedPositionMs(state, nowMs),
    controllerOnline: controllerOnline(state, nowMs),
  }
}

// ---------- Token（HMAC-SHA256，payload 为 base64url JSON） ----------

function b64urlEncode(bytes) {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - str.length % 4) : ''
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const enc = new TextEncoder()

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
}

/** 签发访问 Token：{roomId, memberId, exp}，24h 有效。 */
export async function signToken(tokenSecret, roomId, memberId, nowMs) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    r: roomId, m: memberId, e: nowMs + TOKEN_TTL_MS,
  })))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(tokenSecret), enc.encode(payload))
  return `${payload}.${b64urlEncode(sig)}`
}

/** 校验 Token，返回 {roomId, memberId} 或 null。 */
export async function verifyToken(tokenSecret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  try {
    const ok = await crypto.subtle.verify(
      'HMAC', await hmacKey(tokenSecret),
      b64urlDecode(sig), enc.encode(payload),
    )
    if (!ok) return null
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))
    if (!data.r || !data.m || Date.now() > data.e) return null
    return { roomId: data.r, memberId: data.m }
  } catch {
    return null
  }
}
