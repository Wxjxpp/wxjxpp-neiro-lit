import assert from 'node:assert/strict'
import {
  applyEvent, createRoomState, expectedPositionMs, genRoomId,
  joinRoom, leaveRoom, publicState, signToken, verifyToken, validTrack,
} from '../src/core/protocol.js'

const NOW = 1_700_000_000_000
function newRoom() {
  const host = 'mhost'
  const s = createRoomState({ roomId: 'ABC234', hostMemberId: host, nickname: '房主', nowMs: NOW })
  s.joinSecret = 'JOIN123'
  return { state: s, host }
}

// --- 房间号 ---
assert.match(genRoomId(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/)

// --- 曲目校验：本地歌曲拒绝 ---
assert.equal(validTrack({ songId: '1', sourceId: 'local', title: 'x', durationMs: 100 }), false)
assert.equal(validTrack({ songId: '1', sourceId: 'wy', title: 'x', durationMs: 100 }), true)
assert.equal(validTrack(null), false)

// --- 加入房间 ---
{
  const { state } = newRoom()
  const bad = joinRoom(state, { nickname: '小明', secret: 'WRONG' }, NOW + 1)
  assert.equal(bad.ok, false)
  const ok = joinRoom(state, { nickname: '小明', secret: 'JOIN123' }, NOW + 1)
  assert.equal(ok.ok, true)
  assert.equal(ok.reconnect, false)
  // 加入即暂停（autoPauseOnMemberChange 默认开）
  const st2 = newRoom().state
  applyEvent(st2, 'mhost', { type: 'SET_TRACK', track: { songId: '9', sourceId: 'wy', title: 'T', durationMs: 200000 }, positionMs: 0, shouldPlay: true }, NOW)
  assert.equal(st2.playback.playing, true)
  joinRoom(st2, { nickname: '小红', secret: 'JOIN123' }, NOW + 5000)
  assert.equal(st2.playback.playing, false)
}

// --- 重连：memberSecret 命中则不新增成员、不触发暂停 ---
{
  const { state, host } = newRoom()
  state.members[host].memberSecret = 'MYSECRET'
  applyEvent(state, host, { type: 'SET_TRACK', track: { songId: '9', sourceId: 'wy', title: 'T', durationMs: 200000 }, positionMs: 0 }, NOW)
  const r = joinRoom(state, { nickname: '', secret: 'MYSECRET' }, NOW + 10)
  assert.equal(r.ok && r.reconnect, true)
  assert.equal(Object.keys(state.members).length, 1)
}

// --- 权限：听众不能控制，REQUEST_* 受 stableKey 守卫 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, { type: 'SET_TRACK', track: { songId: '9', sourceId: 'wy', title: 'T', durationMs: 200000 }, positionMs: 0 }, NOW)
  const j = joinRoom(state, { nickname: '听众甲', secret: 'JOIN123' }, NOW + 1)
  const listener = j.memberId
  // 直接 PLAY 被拒
  assert.equal(applyEvent(state, listener, { type: 'PLAY' }, NOW + 2).ok, false)
  // REQUEST_SEEK 目标曲目不匹配被拒
  assert.equal(
    applyEvent(state, listener, { type: 'REQUEST_SEEK', positionMs: 5, requestTrackStableKey: 'wy:999' }, NOW + 2).ok,
    false,
  )
  // 匹配当前曲目 → 通过（allowMemberControl 默认开）
  assert.equal(
    applyEvent(state, listener, { type: 'REQUEST_SEEK', positionMs: 5, requestTrackStableKey: 'wy:9' }, NOW + 2).ok,
    true,
  )
  // 关闭成员控制后同样请求被拒
  applyEvent(state, host, { type: 'UPDATE_SETTINGS', settings: { allowMemberControl: false } }, NOW + 3)
  assert.equal(
    applyEvent(state, listener, { type: 'REQUEST_PAUSE', requestTrackStableKey: 'wy:9' }, NOW + 4).ok,
    false,
  )
}

// --- 位置推算：播放中随时间前进，单曲循环取模回绕 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, { type: 'SET_TRACK', track: { songId: '9', sourceId: 'wy', title: 'T', durationMs: 1000 }, positionMs: 900 }, NOW)
  // 切到单曲循环（repeatMode=1 才做取模回绕；与 NeriPlayer-LTW 语义一致）
  assert.equal(applyEvent(state, host, { type: 'PLAYBACK_MODE', repeatMode: 1, shuffleEnabled: false }, NOW).ok, true)
  assert.equal(expectedPositionMs(state, NOW), 900)
  assert.equal(expectedPositionMs(state, NOW + 250), 150) // 900+250=1150 % 1000
  // 暂停后位置冻结
  applyEvent(state, host, { type: 'PAUSE' }, NOW + 300)
  const frozen = expectedPositionMs(state, NOW + 301)
  assert.equal(expectedPositionMs(state, NOW + 9999), frozen)
}

// --- 幂等：过期 clientSequence 丢弃 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, { type: 'SET_TRACK', track: { songId: '9', sourceId: 'wy', title: 'T', durationMs: 200000 }, positionMs: 0 }, NOW)
  applyEvent(state, host, { type: 'SEEK', positionMs: 1, clientSequence: 5 }, NOW)
  assert.equal(applyEvent(state, host, { type: 'SEEK', positionMs: 2, clientSequence: 3 }, NOW).ok, false)
  assert.equal(applyEvent(state, host, { type: 'SEEK', positionMs: 3, clientSequence: 6 }, NOW).ok, true)
}

// --- 房主离开关房；听众离开不关 ---
{
  const { state, host } = newRoom()
  const j = joinRoom(state, { nickname: '乙', secret: 'JOIN123' }, NOW + 1)
  assert.equal(leaveRoom(state, j.memberId, NOW + 2).closed, false)
  assert.equal(leaveRoom(state, host, NOW + 3).closed, true)
}

// --- 脱敏：快照不含任何密钥 ---
{
  const { state, host } = newRoom()
  state.members[host].memberSecret = 'TOPSECRET'
  const pub = JSON.stringify(publicState(state, NOW))
  assert.equal(pub.includes('TOPSECRET'), false)
  assert.equal(pub.includes('JOIN123'), false)
}

// --- Token 签发与校验 ---
{
  // Token 有效期按真实时钟计算，签发也必须用真实当前时间
  const token = await signToken('secret-key', 'ABC234', 'mhost', Date.now())
  const auth = await verifyToken('secret-key', token)
  assert.equal(auth.roomId, 'ABC234')
  assert.equal(auth.memberId, 'mhost')
  assert.equal(await verifyToken('secret-key', token + 'x'), null)
  assert.equal(await verifyToken('other-key', token), null)
}

console.log('protocol.test.mjs 全部通过 ✅')
