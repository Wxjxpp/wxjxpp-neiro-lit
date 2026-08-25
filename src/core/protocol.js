/**
 * Neiro-LIT 一起听 · 协议核心 v2「民主房间」（纯逻辑，Cloudflare Workers 与 Vercel 共享）
 *
 * 设计要点：
 * - 服务端是唯一权威：expectedPositionMs 由 basePositionMs + elapsed*rate 推算。
 * - 双角色：controller（房主）拥有全部控制权；listener（群友）可加歌/投票/聊天，
 *   可选开启 allowMemberControl 让群友控制播放。
 * - 音频源：群友提交直链 URL（http/https，mp3/flac/m3u8 等），服务端暂存至房毁；
 *   提交时由平台层探测可用性（见 probe.js），协议层做哈希去重。
 * - 民主切歌：实时统计当前曲目踩票占比，≥ voteSkipThreshold%（默认 50）立即切下一首。
 * - 兜底：客户端检测 URL 失效/加载超时上报 TRACK_ERROR，标记无效源并自动跳过。
 * - 身份：joinSecret（邀请首次入房）+ memberSecret（重连）+ HMAC Token（24h）。
 * - 密钥绝不出现在脱敏快照中。
 */
export const ROOM_ID_ALPHABET = '0123456789'
export const ROOM_ID_LENGTH = 6
export const QUEUE_LIMIT = 500
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** 成员超过该时长无任何活动视为离线。 */
export const CONTROLLER_OFFLINE_MS = 45 * 1000
/** 控制者离线超过该时长自动关房（释放存储）。 */
export const ROOM_AUTO_CLOSE_MS = 10 * 60 * 1000
export const NICKNAME_MAX = 24
export const CHAT_MAX = 80
export const CHAT_TEXT_MAX = 200
export const URL_MAX = 2048
/** 默认民主切歌阈值（%）。 */
export const DEFAULT_VOTE_SKIP_THRESHOLD = 50

export const CONTROL_EVENTS = new Set([
  'PLAY', 'PAUSE', 'SEEK', 'SET_TRACK', 'SET_QUEUE',
  'ADD_SONG', 'REMOVE_SONG', 'NEXT', 'PREV', 'TRACK_ERROR',
  'UPDATE_SETTINGS', 'HEARTBEAT', 'KICK',
])
export const REQUEST_EVENTS = new Set([
  'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK', 'REQUEST_SET_TRACK', 'REQUEST_SET_QUEUE',
  'REQUEST_ADD_SONG', 'REQUEST_REMOVE_SONG', 'REQUEST_NEXT', 'REQUEST_PREV', 'REQUEST_TRACK_ERROR',
  'REQUEST_TRACK_END', 'REQUEST_PLAY_INDEX',
])
const MEMBER_CONTROLLED = new Set([
  'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK',
])
/** 全员可用（不受 allowMemberControl 门控）：投票与聊天。 */
export const OPEN_REQUEST_EVENTS = new Set(['VOTE', 'CHAT'])
/** 播完上报的宽限毫秒数：期望进度距曲尾不足该值即认可「已播完」。 */
const TRACK_END_GRACE_MS = 1500

export function genRoomId(random = Math.random) {
  let s = ''
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    s += ROOM_ID_ALPHABET[Math.floor(random() * ROOM_ID_ALPHABET.length)]
  }
  return s
}
export function genSecret(random = Math.random) {
  // 128bit 等价的可读密钥（26 字符 base36 混合）
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

// ---------- URL 音源 ----------
/**
 * URL 稳定哈希（djb2 → 16 进制）。非加密哈希，仅用于去重键，
 * 同步计算保证协议层纯函数特性（CF Workers / Node 结果一致）。
 */
export function urlHash(url) {
  let h = 5381
  const s = String(url).trim()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}
export function validUrl(u) {
  return typeof u === 'string' && u.length > 8 && u.length <= URL_MAX &&
    /^https?:\/\/\S+$/i.test(u.trim())
}
/** 曲目稳定键。 */
export function stableKeyOf(track) {
  return `${track.sourceId}:${track.songId}`
}
/**
 * 平台曲目校验（原有 LX 类音源）：songId/sourceId/title/durationMs 必备。
 */
export function validPlatformTrack(t) {
  return !!t &&
    typeof t.songId === 'string' && t.songId.length > 0 &&
    typeof t.sourceId === 'string' && t.sourceId.length > 0 &&
    t.sourceId !== 'local' && t.sourceId !== 'url' &&
    typeof t.title === 'string' && t.title.length <= 200 &&
    Number.isFinite(t.durationMs) && t.durationMs >= 0
}
/** URL 直链曲目校验：url 合法、title 必填、时长允许未知(0)。 */
export function validUrlTrack(t) {
  return !!t &&
    t.sourceId === 'url' && validUrl(t.url) &&
    typeof t.title === 'string' && t.title.length > 0 && t.title.length <= 200 &&
    (t.durationMs === undefined || (Number.isFinite(t.durationMs) && t.durationMs >= 0))
}
/** 统一曲目校验入口。 */
export function validTrack(t) {
  return validPlatformTrack(t) || validUrlTrack(t)
}
function clampText(v, n) { return String(v ?? '').slice(0, n) }
function sanitizePlatformTrack(t, keepPayload = false) {
  const out = {
    stableKey: stableKeyOf(t),
    songId: String(t.songId),
    sourceId: String(t.sourceId),
    title: clampText(t.title, 200),
    artist: clampText(t.artist, 200),
    album: clampText(t.album, 200),
    durationMs: Math.max(0, Math.round(t.durationMs || 0)),
    cover: typeof t.cover === 'string' ? t.cover.slice(0, 500) : '',
    invalid: false,
  }
  // payload：平台搜索原始 JSON（听众端取流必需）。只随当前曲目透传（上限 16KB）。
  if (keepPayload && typeof t.payload === 'string' && t.payload.length > 0 && t.payload.length <= 16384) {
    out.payload = t.payload
  }
  return out
}
function sanitizeUrlTrack(t, addedBy = '') {
  const url = String(t.url).trim()
  const hash = urlHash(url)
  return {
    stableKey: `url:${hash}`,
    songId: hash,
    sourceId: 'url',
    url,
    title: clampText(t.title, 200),
    artist: clampText(t.artist, 200),
    album: clampText(t.album, 200),
    durationMs: Math.max(0, Math.round(t.durationMs || 0)),
    cover: typeof t.cover === 'string' ? t.cover.slice(0, 500) : '',
    addedBy: clampText(addedBy, NICKNAME_MAX),
    invalid: false,
  }
}
function sanitizeTrack(t, keepPayload = false, addedBy = '') {
  return t.sourceId === 'url' ? sanitizeUrlTrack(t, addedBy) : sanitizePlatformTrack(t, keepPayload)
}

export function createRoomState({ roomId, hostMemberId, nickname, nowMs }) {
  return {
    schemaVersion: 2,
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
    },
    /** 当前曲目的投票状态（换歌即清零；每人每首歌限投 1 次）。 */
    votes: { up: [], down: [] },
    /** 弹幕/聊天记录（环形缓冲，最近 CHAT_MAX 条）。 */
    chat: [],
    settings: {
      allowMemberControl: true,
      autoPauseOnMemberChange: false,
      /** 锁定加歌：true 时只有房主能 ADD_SONG。 */
      lockAddSongs: false,
      /** 民主切歌阈值（踩票占比 %，10-100）。 */
      voteSkipThreshold: DEFAULT_VOTE_SKIP_THRESHOLD,
    },
  }
}
/** 在线成员数：窗口内有活动（心跳/轮询/事件）的成员。 */
export function onlineCount(state, nowMs) {
  return Object.values(state.members)
    .filter((m) => nowMs - m.lastSeenMs < CONTROLLER_OFFLINE_MS).length
}
/** 加入成员（含重连识别）。返回 {ok, state, memberId, reconnect} 或 {ok:false, error}。 */
export function joinRoom(state, { nickname, secret, uid }, nowMs) {
  if (state.closed) return { ok: false, error: '房间已关闭' }
  // 重连识别①：uid 命中（设备唯一身份；卸载重装/清数据后仍能归位同一成员）
  if (uid) {
    for (const m of Object.values(state.members)) {
      if (m.uid && m.uid === uid) {
        if (nickname && validNickname(nickname)) m.nickname = nickname
        m.lastSeenMs = nowMs
        state.version++
        return { ok: true, state, memberId: m.memberId, reconnect: true }
      }
    }
  }
  // 重连识别②：memberSecret 命中（旧版本客户端兼容）
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
  // 重名拒绝：同房间内已有成员使用该昵称时，新加入者必须改名
  const taken = Object.values(state.members).some(
    (m) => m.nickname === nickname && !(m.memberSecret && secret && m.memberSecret === secret),
  )
  if (taken) return { ok: false, code: 'NAME_TAKEN', error: '该名称已被占用，换一个吧' }
  const memberId = 'm' + genSecret().slice(0, 12).toLowerCase()
  state.members[memberId] = {
    memberId, nickname, role: 'listener',
    joinedAt: nowMs, lastSeenMs: nowMs, memberSecret: null, seq: 0,
    ...(uid ? { uid } : {}),
  }
  state.version++
  return { ok: true, state, memberId, reconnect: false }
}
export function leaveRoom(state, memberId, nowMs) {
  const m = state.members[memberId]
  if (!m) return { ok: false, error: '不是房间成员' }
  delete state.members[memberId]
  // 从当前投票中摘除离场者
  if (state.votes) {
    state.votes.up = state.votes.up.filter((x) => x !== memberId)
    state.votes.down = state.votes.down.filter((x) => x !== memberId)
  }
  if (m.role === 'controller') state.closed = true
  state.version++
  return { ok: true, state, closed: m.role === 'controller' }
}
/** 踢人（仅房主，applyEvent 已收口权限）。 */
export function removeMember(state, memberId, nowMs) {
  const m = state.members[memberId]
  if (!m || m.role === 'controller') {
    return { ok: false, error: '目标不存在或不能踢房主' }
  }
  delete state.members[memberId]
  state.version++
  return { ok: true }
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
  const dur = state.playback.track?.durationMs || 0
  if (dur > 0) return Math.max(0, Math.min(pos, dur))
  return Math.max(0, pos)
}
/** 服务端权威位置推算：客户端用它 + nowMs 校正本地进度。 */
export function expectedPositionMs(state, nowMs) {
  const p = state.playback
  if (!p.playing || !p.track) return Math.max(0, p.basePositionMs)
  const pos = p.basePositionMs + Math.max(0, nowMs - p.anchoredAtMs) * (p.rate || 1)
  const dur = p.track.durationMs
  if (dur > 0) return Math.max(0, Math.min(Math.floor(pos), dur))
  return Math.max(0, Math.floor(pos))
}
function controllerOnline(state, nowMs) {
  const c = state.members[state.controllerId]
  return !!c && (nowMs - c.lastSeenMs) < CONTROLLER_OFFLINE_MS
}
/** 清空当前曲目投票（换歌调用）。 */
function resetVotes(state) {
  state.votes = { up: [], down: [] }
}
/**
 * 切到下一首有效曲目；没有则待机。
 * @returns 'switched' | 'standby'
 */
export function skipNext(state, nowMs) {
  const p = state.playback
  return gotoIndex(state, p.currentIndex + 1, nowMs)
}
/**
 * 跳到队列第 [idx] 首并开播（环形；跳过 invalid 项，最多扫一整圈）。
 * NEXT/PREV/PLAY_INDEX/TRACK_END 播完推进共用这一条路径，保证行为一致。
 */
export function gotoIndex(state, idx, nowMs) {
  const p = state.playback
  if (p.queue.length === 0) return toStandby(state, nowMs)
  const n = p.queue.length
  for (let k = 0; k < n; k++) {
    const i = ((idx % n) + n) % n
    if (!p.queue[i].invalid) {
      p.currentIndex = i
      p.track = { ...p.queue[i] }
      delete p.track.payload // 队列副本不带 payload；当前曲目按需透传
      p.basePositionMs = 0
      p.anchoredAtMs = nowMs
      p.playing = true
      resetVotes(state)
      return 'switched'
    }
    idx++
  }
  return toStandby(state, nowMs)
}
export function skipPrev(state, nowMs) {
  const p = state.playback
  if (p.queue.length === 0) return toStandby(state, nowMs)
  const cur = p.currentIndex < 0 ? 0 : p.currentIndex
  for (let i = 0; i < p.queue.length; i++) {
    const idx = (((cur - 1 - i) % p.queue.length) + p.queue.length) % p.queue.length
    if (!p.queue[idx].invalid) {
      p.currentIndex = idx
      p.track = { ...p.queue[idx] }
      delete p.track.payload
      p.basePositionMs = 0
      p.anchoredAtMs = nowMs
      p.playing = true
      resetVotes(state)
      return 'switched'
    }
  }
  return toStandby(state, nowMs)
}
function toStandby(state, nowMs) {
  const p = state.playback
  p.track = null
  p.playing = false
  p.basePositionMs = 0
  p.anchoredAtMs = nowMs
  p.currentIndex = -1
  resetVotes(state)
  return 'standby'
}
/** 民主切歌判定：踩票占比 ≥ 阈值 → 自动切歌。返回是否触发。 */
function maybeDemocraticSkip(state, nowMs) {
  const online = Math.max(1, onlineCount(state, nowMs))
  const thresholdPct = Math.min(100, Math.max(10, state.settings.voteSkipThreshold || DEFAULT_VOTE_SKIP_THRESHOLD))
  if (state.votes.down.length / online >= thresholdPct / 100) {
    skipNext(state, nowMs)
    return true
  }
  return false
}
/**
 * 播完自动切歌（时间轴驱动，房主离线也会推进）。
 * 由平台层在轮询路径与事件路径调用；时长未知(0)不推进。
 * @returns 是否发生了切歌（调用方据此决定是否落盘）
 */
export function advanceIfTrackEnded(state, nowMs) {
  const p = state.playback
  if (state.closed || !p.track || !p.track.durationMs) return false
  const pos = expectedPositionMs(state, nowMs)
  // 还没播到结尾：不推进（暂停在中间不算播完）
  if (pos + 200 < p.track.durationMs) return false
  // 在播且时间到 → 推进；暂停但停在曲尾（本机播完后的暂停）→ 同样推进。
  // 后者是关键：房主本机播完会暂停，若不推进整个房间会被冻结在最后一首。
  if (p.playing || pos >= p.track.durationMs) {
    gotoIndex(state, p.currentIndex + 1, nowMs)
    return true
  }
  return false
}
/**
 * 应用一个控制/请求事件（纯函数，直接改写传入 state 并递增 version）。
 * 返回 {ok} 或 {ok:false, error}。
 */
export function applyEvent(state, actorId, evt, nowMs) {
  if (state.closed) return { ok: false, error: '房间已关闭' }
  const actor = state.members[actorId]
  if (!actor) return { ok: false, error: '不是房间成员' }
  actor.lastSeenMs = nowMs
  // 播完上报自己带闸门判定，不走入口预推进（否则曲目先被切走、闸门永远误判）
  if (evt.type !== 'TRACK_END' && evt.type !== 'REQUEST_TRACK_END') {
    advanceIfTrackEnded(state, nowMs)
  }
  // 幂等/乱序防护：同一成员的事件序号必须递增（HEARTBEAT/VOTE 除外——需幂等重试安全）
  if (evt.type !== 'HEARTBEAT' && evt.type !== 'VOTE') {
    const seq = Number(evt.clientSequence)
    if (Number.isFinite(seq)) {
      if (seq <= actor.seq) return { ok: false, error: '过期事件已丢弃' }
      actor.seq = seq
    }
  }
  const type = evt.type
  const isHost = actor.role === 'controller'

  // ---- 全员开放：投票 / 聊天 ----
  if (OPEN_REQUEST_EVENTS.has(type)) {
    if (type === 'VOTE') {
      const p = state.playback
      if (!p.track) return { ok: false, error: '当前没有播放中的歌曲' }
      // 房主不参与投票：民主切歌只统计群友，避免房主一票定生死
      if (actor.role === 'controller') {
        return { ok: false, error: '房主不参与投票（切歌只看群友）' }
      }
      const vote = evt.vote === 'up' ? 'up' : evt.vote === 'down' ? 'down' : null
      if (!vote) return { ok: false, error: 'vote 仅接受 up/down' }
      if (state.votes.up.includes(actorId) || state.votes.down.includes(actorId)) {
        return { ok: false, error: '每人每首歌限投一次' }
      }
      state.votes[vote].push(actorId)
      state.version++
      maybeDemocraticSkip(state, nowMs)
      return { ok: true }
    }
    if (type === 'CHAT') {
      const text = clampText(evt.text, CHAT_TEXT_MAX).trim()
      if (!text) return { ok: false, error: '消息不能为空' }
      // 限频：每成员 ≥1.5s 一条
      const last = actor.lastChatAt || 0
      if (nowMs - last < 1500) return { ok: false, error: '发送太频繁' }
      actor.lastChatAt = nowMs
      state.chat.push({ id: state.version + 1, fromId: actorId, from: actor.nickname, text, at: nowMs })
      if (state.chat.length > CHAT_MAX) state.chat.splice(0, state.chat.length - CHAT_MAX)
      state.version++
      return { ok: true }
    }
  }

  // ---- 房主专属控制 ----
  if (isHost) return applyControl(state, type, evt, nowMs, actor.nickname, true)

  // ---- 群友请求（受门控：加歌只需未锁定；其余需房主开启成员控制）----
  if (REQUEST_EVENTS.has(type)) {
    const action = type.slice(8)
    // 点歌/无效源上报/播完推进不依赖房主设置（基础功能与安全兜底）
    if (action !== 'ADD_SONG' && action !== 'TRACK_ERROR' && action !== 'TRACK_END' &&
        !state.settings.allowMemberControl) {
      return { ok: false, error: '房主未开启成员控制' }
    }
    // 点歌/无效源上报/播完推进也不要求房主在线；其余控制类请求需要房主在线兜底
    if (action !== 'ADD_SONG' && action !== 'TRACK_ERROR' && action !== 'TRACK_END' &&
        !controllerOnline(state, nowMs)) return { ok: false, error: '房主不在线' }
    if (MEMBER_CONTROLLED.has(type)) {
      const want = evt.requestTrackStableKey || (evt.track && stableKeyOf(evt.track)) || ''
      const cur = state.playback.track
      if (!cur || want !== cur.stableKey) {
        return { ok: false, error: '目标歌曲已切换，请求被拒绝' }
      }
    }
    return applyControl(state, action, evt, nowMs, actor.nickname)
  }
  return { ok: false, error: `未知事件类型 ${type}` }
}
function applyControl(state, action, evt, nowMs, actorNick = '', isHost = false) {
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
    case 'SET_TRACK': {
      const t = evt.track
      if (!validTrack(t)) return { ok: false, error: '不支持本地歌曲或曲目数据不完整' }
      const idx = Array.isArray(evt.queue)
        ? evt.queue.findIndex((x) => x && stableKeyOf(x) === stableKeyOf(t))
        : p.queue.findIndex((x) => x.stableKey === stableKeyOf(t))
      p.queue = normalizeQueue(evt.queue, p.queue)
      p.currentIndex = idx >= 0 ? idx : p.queue.findIndex((x) => x.stableKey === stableKeyOf(t))
      p.track = sanitizeTrack(t, true) // 当前曲目保留 payload 供听众取流
      const shouldPlay = evt.shouldPlay === undefined ? true : !!evt.shouldPlay
      p.basePositionMs = Math.max(0, Number(evt.positionMs) || 0)
      p.anchoredAtMs = nowMs
      p.playing = shouldPlay
      resetVotes(state)
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
      p.queue = evt.queue.map((t) => sanitizeTrack(t))
      if (p.track) {
        p.currentIndex = p.queue.findIndex((x) => x.stableKey === p.track.stableKey)
      }
      break
    }
    /**
     * 加歌（全员可用，受 lockAddSongs 门控——门控在 applyEvent 收口）。
     * URL 可用性探测由平台层在调用本函数前完成（probe.js）。
     */
    case 'ADD_SONG': {
      if (state.settings.lockAddSongs && !isHost) return { ok: false, error: '房主已锁定添加歌曲' }
      const t = evt.track
      if (!validTrack(t)) return { ok: false, error: 'URL 不合法或元数据缺失' }
      if (p.queue.length >= QUEUE_LIMIT) return { ok: false, error: '队列超出上限' }
      const nt = sanitizeTrack(t, false, actorNick)
      // URL 哈希去重（含当前曲目与整个队列）
      if (nt.sourceId === 'url') {
        const dupQueue = p.queue.some((x) => x.stableKey === nt.stableKey)
        const dupCur = !!(p.track && p.track.stableKey === nt.stableKey)
        if (dupQueue || dupCur) return { ok: false, error: '这首已经在列表里了' }
      }
      p.queue.push(nt)
      // 待机中直接开播新歌
      if (!p.track) {
        p.currentIndex = p.queue.length - 1
        p.track = { ...nt }
        p.basePositionMs = 0
        p.anchoredAtMs = nowMs
        p.playing = true
        resetVotes(state)
      }
      break
    }
    case 'REMOVE_SONG': {
      const key = String(evt.stableKey || '')
      const idx = p.queue.findIndex((x) => x.stableKey === key)
      if (idx < 0) return { ok: false, error: '曲目不在列表中' }
      const wasCurrent = idx === p.currentIndex
      p.queue.splice(idx, 1)
      if (wasCurrent) {
        if (p.queue.length === 0) toStandby(state, nowMs)
        else skipNext(state, nowMs)
      } else if (idx < p.currentIndex) {
        p.currentIndex--
      }
      break
    }
    case 'NEXT':
      gotoIndex(state, p.currentIndex + 1, nowMs)
      break
    case 'PREV':
      gotoIndex(state, p.currentIndex - 1, nowMs)
      break
    /**
     * 房主点歌单任意曲目开播（客户端把队列下标发上来）。
     */
    case 'PLAY_INDEX': {
      const idx = Math.floor(Number(evt.index))
      if (!Number.isFinite(idx)) return { ok: false, error: 'index 非法' }
      gotoIndex(state, idx, nowMs)
      break
    }
    /**
     * 播完上报：任一成员本机播完当前曲目即推进下一首。
     * 以服务端期望进度超过曲目时长为闸，防止提前上报/重复触发；
     * 这是「房主离线也能连续放歌」的核心事件。
     */
    case 'TRACK_END': {
      const cur = p.track
      if (!cur) return { ok: false, error: '当前没有曲目' }
      if (expectedPositionMs(state, nowMs) < (cur.durationMs || 0) - TRACK_END_GRACE_MS) {
        return { ok: false, error: '歌曲尚未播完' }
      }
      gotoIndex(state, p.currentIndex + 1, nowMs)
      break
    }
    /**
     * 无效源兜底：客户端 URL 失效/加载超时(>5s)上报，标记并立即跳过。
     */
    case 'TRACK_ERROR': {
      const cur = p.track
      if (!cur) return { ok: false, error: '当前没有曲目' }
      cur.invalid = true
      const qi = p.queue.findIndex((x) => x.stableKey === cur.stableKey)
      if (qi >= 0) p.queue[qi].invalid = true
      skipNext(state, nowMs)
      break
    }
    case 'KICK': {
      const r = removeMember(state, String(evt.targetId || ''), nowMs)
      if (!r.ok) return r
      break
    }
    case 'UPDATE_SETTINGS': {
      const s = evt.settings || {}
      if (typeof s.allowMemberControl === 'boolean') state.settings.allowMemberControl = s.allowMemberControl
      if (typeof s.autoPauseOnMemberChange === 'boolean') state.settings.autoPauseOnMemberChange = s.autoPauseOnMemberChange
      if (typeof s.lockAddSongs === 'boolean') state.settings.lockAddSongs = s.lockAddSongs
      if (Number.isFinite(Number(s.voteSkipThreshold))) {
        state.settings.voteSkipThreshold = Math.min(100, Math.max(10, Math.round(Number(s.voteSkipThreshold))))
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
  return incoming.map((t) => sanitizeTrack(t))
}

/**
 * 脱敏快照：剔除一切密钥，附上服务端推算位置、时钟、在线数与投票摘要。
 */
export function publicState(state, nowMs) {
  const { joinSecret, ...rest } = state
  const members = Object.fromEntries(Object.entries(state.members).map(([k, m]) => [
    k, {
      ...m,
      memberSecret: undefined, seq: undefined, lastChatAt: undefined, uid: undefined,
      /** 该成员是否在线（窗口内有心跳/轮询活动）。 */
      online: nowMs - m.lastSeenMs < CONTROLLER_OFFLINE_MS,
    },
  ]))
  return {
    ...rest,
    members,
    serverNowMs: nowMs,
    expectedPositionMs: expectedPositionMs(state, nowMs),
    controllerOnline: controllerOnline(state, nowMs),
    onlineCount: onlineCount(state, nowMs),
    voteSummary: {
      up: state.votes.up.length,
      down: state.votes.down.length,
      upIds: state.votes.up,
      downIds: state.votes.down,
      threshold: state.settings.voteSkipThreshold,
    },
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
    if (!data.r || !data.m || data.e < Date.now()) return null
    return { roomId: data.r, memberId: data.m }
  } catch {
    return null
  }
}