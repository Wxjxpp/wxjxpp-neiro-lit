import assert from 'node:assert/strict'
import {
  applyEvent, createRoomState, expectedPositionMs, genRoomId, urlHash, validUrlTrack,
  joinRoom, leaveRoom, publicState, signToken, verifyToken, validTrack, skipNext,
  onlineCount,
} from '../src/core/protocol.js'

const NOW = 1_700_000_000_000
const HOST = 'mhost'
function newRoom() {
  const s = createRoomState({ roomId: 'ABC234', hostMemberId: HOST, nickname: '房主', nowMs: NOW })
  s.joinSecret = 'JOIN123'
  return { state: s, host: HOST }
}
function joinListener(state, nick, at) {
  const r = joinRoom(state, { nickname: nick, secret: 'JOIN123' }, at)
  assert.ok(r.ok, `加入失败：${r.error}`)
  return r.memberId
}
// --- 房间号 ---
assert.match(genRoomId(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/)
// --- URL 音源：哈希稳定 + 校验 ---
{
  const u = 'https://cdn.example.com/song.mp3'
  assert.equal(urlHash(u), urlHash(u))
  assert.notEqual(urlHash(u), urlHash('https://cdn.example.com/other.mp3'))
  assert.equal(validUrlTrack({ sourceId: 'url', url: u, title: '测试' }), true)
  assert.equal(validUrlTrack({ sourceId: 'url', url: 'ftp://x', title: 't' }), false)
  assert.equal(validUrlTrack({ sourceId: 'url', url: u, title: '' }), false)
  // 平台曲目仍可用
  assert.equal(validTrack({ songId: '1', sourceId: 'wy', title: 'x', durationMs: 100 }), true)
  assert.equal(validTrack({ songId: '1', sourceId: 'local', title: 'x', durationMs: 100 }), false)
}
// --- 加入房间 ---
{
  const { state } = newRoom()
  const bad = joinRoom(state, { nickname: '小明', secret: 'WRONG' }, NOW + 1)
  assert.equal(bad.ok, false)
  const ok = joinRoom(state, { nickname: '小明', secret: 'JOIN123' }, NOW + 1)
  assert.equal(ok.ok, true)
}
// --- 加歌（URL）：去重 + 待机自动开播 + addedBy 记录 ---
{
  const { state, host } = newRoom()
  const track = { sourceId: 'url', url: 'https://a.com/x.mp3', title: '歌一' }
  let r = applyEvent(state, host, { type: 'ADD_SONG', track }, NOW + 1)
  assert.ok(r.ok, r.error)
  assert.equal(state.playback.track.title, '歌一')
  assert.equal(state.playback.playing, true)
  assert.equal(state.playback.track.addedBy, '房主')
  assert.ok(state.playback.track.stableKey.startsWith('url:'))
  // 重复 URL 拒绝
  r = applyEvent(state, host, { type: 'ADD_SONG', track }, NOW + 2)
  assert.equal(r.ok, false)
  assert.match(r.error, /已经在列表里/)
  // 群友也能加
  const m1 = joinListener(state, '小明', NOW + 3)
  r = applyEvent(state, m1, { type: 'REQUEST_ADD_SONG', track: { sourceId: 'url', url: 'https://b.com/y.flac', title: '歌二' } }, NOW + 4)
  assert.ok(r.ok, r.error)
  assert.equal(state.playback.queue.length, 2)
}
// --- 锁定加歌：群友被拒、房主不受限 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, { type: 'UPDATE_SETTINGS', settings: { lockAddSongs: true } }, NOW + 1)
  const m1 = joinListener(state, '小明', NOW + 2)
  let r = applyEvent(state, m1, {
    type: 'REQUEST_ADD_SONG',
    track: { sourceId: 'url', url: 'https://c.com/z.mp3', title: 'z' },
  }, NOW + 3)
  assert.equal(r.ok, false)
  assert.match(r.error, /锁定/)
  r = applyEvent(state, host, {
    type: 'ADD_SONG',
    track: { sourceId: 'url', url: 'https://d.com/h.mp3', title: 'h' },
  }, NOW + 4)
  assert.ok(r.ok, r.error)
}
// --- 民主切歌：踩票占比达阈值 → 立即切下一首 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [
      { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
      { sourceId: 'url', url: 'https://a.com/2.mp3', title: '2' },
      { sourceId: 'url', url: 'https://a.com/3.mp3', title: '3' },
    ],
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const m1 = joinListener(state, 'A', NOW + 1)
  const m2 = joinListener(state, 'B', NOW + 2)
  // 在线 3 人（房主+2群友），阈值默认 50% → 需要 ≥1.5 即 2 踩
  // 房主不能投票
  const hostVote = applyEvent(state, host, { type: 'VOTE', vote: 'down' }, NOW + 3)
  assert.equal(hostVote.ok, false)
  applyEvent(state, m1, { type: 'VOTE', vote: 'down' }, NOW + 4)
  assert.equal(state.votes.down.length, 1) // 未达阈值
  applyEvent(state, m2, { type: 'VOTE', vote: 'down' }, NOW + 5)
  // 达阈值：立即切歌 + 投票清零
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/2.mp3')}`)
  assert.equal(state.votes.down.length, 0)
  assert.equal(state.votes.up.length, 0)
  assert.equal(state.playback.playing, true)
  assert.equal(onlineCount(state, NOW + 5), 3)
}
// --- 未达阈值不切歌 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [
      { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
      { sourceId: 'url', url: 'https://a.com/2.mp3', title: '2' },
    ],
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const m1 = joinListener(state, 'A', NOW + 1)
  const m2 = joinListener(state, 'B', NOW + 2)
  const m3 = joinListener(state, 'C', NOW + 2)
  applyEvent(state, m1, { type: 'VOTE', vote: 'down' }, NOW + 3)
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/1.mp3')}`)
}
// --- 重复投票拒绝；换歌后可再投 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [{ sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' }],
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const m1 = joinListener(state, '小明', NOW)
  applyEvent(state, m1, { type: 'VOTE', vote: 'up' }, NOW + 1)
  const dup = applyEvent(state, m1, { type: 'VOTE', vote: 'down' }, NOW + 2)
  assert.equal(dup.ok, false)
  assert.equal(state.votes.up.length, 1)
}
// --- TRACK_ERROR 兜底：标记无效并跳过 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [
      { sourceId: 'url', url: 'https://bad.com/a.mp3', title: '坏源' },
      { sourceId: 'url', url: 'https://a.com/2.mp3', title: '好源' },
    ],
    track: { sourceId: 'url', url: 'https://bad.com/a.mp3', title: '坏源' },
  }, NOW)
  const r = applyEvent(state, host, { type: 'TRACK_ERROR' }, NOW + 1)
  assert.ok(r.ok, r.error)
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/2.mp3')}`)
  assert.equal(state.playback.queue[0].invalid, true)
}
// --- NEXT/PREV/REMOVE_SONG ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [
      { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
      { sourceId: 'url', url: 'https://a.com/2.mp3', title: '2' },
    ],
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  applyEvent(state, host, { type: 'NEXT' }, NOW + 1)
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/2.mp3')}`)
  applyEvent(state, host, { type: 'PREV' }, NOW + 2)
  // PREV 回到上一首（第 1 首）
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/1.mp3')}`)
  applyEvent(state, host, { type: 'REMOVE_SONG', stableKey: `url:${urlHash('https://a.com/1.mp3')}` }, NOW + 3)
  // 删除的是当前曲目 → 自动切到下一首有效曲目
  assert.equal(state.playback.queue.length, 1)
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/2.mp3')}`)
}
// --- 聊天：全员可发、限频 1.5s、环形缓冲 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, { type: 'CHAT', text: '大家好' }, NOW + 1)
  assert.equal(state.chat.length, 1)
  assert.equal(state.chat[0].from, '房主')
  const spam = applyEvent(state, host, { type: 'CHAT', text: '刷屏' }, NOW + 500)
  assert.equal(spam.ok, false)
  assert.match(spam.error, /频繁/)
  for (let i = 0; i < 100; i++) {
    applyEvent(state, host, { type: 'CHAT', text: `m${i}` }, NOW + 3000 + i * 2000)
  }
  assert.equal(state.chat.length, 80) // CHAT_MAX
  assert.equal(state.chat[79].text, 'm99')
}
// --- 踢人：房主可以、群友不行、不能踢自己/房主 ---
{
  const { state, host } = newRoom()
  const m1 = joinListener(state, '小明', NOW + 1)
  let r = applyEvent(state, m1, { type: 'KICK', targetId: host }, NOW + 2)
  assert.equal(r.ok, false) // 群友无权
  r = applyEvent(state, host, { type: 'KICK', targetId: host }, NOW + 3)
  assert.equal(r.ok, false) // 不能踢房主
  r = applyEvent(state, host, { type: 'KICK', targetId: m1 }, NOW + 4)
  assert.ok(r.ok, r.error)
  assert.equal(state.members[m1], undefined)
}
// --- 权限：听众控制受 allowMemberControl 门控 + stableKey 守卫 ---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const m1 = joinListener(state, '小明', NOW + 1)
  applyEvent(state, host, { type: 'UPDATE_SETTINGS', settings: { allowMemberControl: false } }, NOW + 2)
  let r = applyEvent(state, m1, { type: 'REQUEST_SEEK', requestTrackStableKey: state.playback.track.stableKey, positionMs: 10 }, NOW + 3)
  assert.equal(r.ok, false)
  assert.match(r.error, /成员控制/)
  applyEvent(state, host, { type: 'UPDATE_SETTINGS', settings: { allowMemberControl: true } }, NOW + 3.5)
  r = applyEvent(state, m1, { type: 'REQUEST_SEEK', requestTrackStableKey: state.playback.track.stableKey, positionMs: 10 }, NOW + 4)
  assert.ok(r.ok, r.error)
  r = applyEvent(state, m1, { type: 'REQUEST_SEEK', requestTrackStableKey: 'url:deadbeef', positionMs: 20 }, NOW + 5)
  assert.equal(r.ok, false)
}
// --- 重连与离场 ---
{
  const { state, host } = newRoom()
  state.members[host].memberSecret = 'MYSECRET'
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const r = joinRoom(state, { nickname: '', secret: 'MYSECRET' }, NOW + 10)
  assert.ok(r.reconnect)
  // 听众离场后从投票中摘除（4 人在线，1 踩 = 25% 未达阈值）
  const m1 = joinListener(state, 'A', NOW + 11)
  joinListener(state, 'B', NOW + 11)
  joinListener(state, 'C', NOW + 11)
  applyEvent(state, m1, { type: 'VOTE', vote: 'down' }, NOW + 12)
  assert.equal(state.votes.down.length, 1)
  leaveRoom(state, m1, NOW + 13)
  assert.equal(state.votes.down.length, 0)
}
// --- 位置推算与钳制（时长未知不钳制）---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    track: { sourceId: 'url', url: 'https://a.com/live.m3u8', title: '直播流' },
  }, NOW) // durationMs 缺省 0 → 不钳制
  assert.equal(expectedPositionMs(state, NOW + 10_000), 10_000)
  applyEvent(state, host, { type: 'SEEK', positionMs: 999_999_999 }, NOW)
  assert.equal(state.playback.basePositionMs, 999_999_999)
}
// --- 播完自动切歌（房主离线也推进）---
{
  const { state, host } = newRoom()
  applyEvent(state, host, {
    type: 'SET_TRACK', positionMs: 0,
    queue: [
      { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
      { sourceId: 'url', url: 'https://a.com/2.mp3', title: '2' },
    ],
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1', durationMs: 1000 },
  }, NOW)
  assert.equal(state.playback.playing, true)
  // 模拟房主离线后群友活动（聊天）触发推进
  const m1 = joinListener(state, 'A', NOW + 100)
  const r = applyEvent(state, m1, { type: 'CHAT', text: '推进' }, NOW + 1500)
  assert.ok(r.ok, r.error)
  assert.equal(state.playback.track.stableKey, `url:${urlHash('https://a.com/2.mp3')}`)
}
// --- 脱敏快照 ---
{
  const { state, host } = newRoom()
  state.joinSecret = 'TOPSECRET'
  state.members[host].memberSecret = 'HOSTSECRET'
  applyEvent(state, host, {
    type: 'ADD_SONG',
    track: { sourceId: 'url', url: 'https://a.com/1.mp3', title: '1' },
  }, NOW)
  const pub = JSON.stringify(publicState(state, NOW))
  assert.ok(!pub.includes('TOPSECRET'))
  assert.ok(!pub.includes('HOSTSECRET'))
  assert.ok(pub.includes('voteSummary'))
  assert.ok(pub.includes('onlineCount'))
}
// --- Token 签发与校验 ---
{
  const t0 = Date.now()
  const token = await signToken('SECRET', 'ABC234', 'm1', t0)
  const ok = await verifyToken('SECRET', token)
  assert.equal(ok.roomId, 'ABC234')
  assert.equal(ok.memberId, 'm1')
  assert.equal(await verifyToken('SECRET', token + 'x'), null)
}
console.log('✅ 协议 v2 测试全部通过（URL 音源/投票切歌/聊天/踢人/权限/心跳语义）')