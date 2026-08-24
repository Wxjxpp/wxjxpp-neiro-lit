# Neiro-LIT

**Neiro 一起听服务端** · 参考 [NeriPlayer-LTW](https://github.com/TheSmallHanCat/NeriPlayer-LTW) 的房态权威模型实现，支持 **Cloudflare Workers** 与 **Vercel** 双平台部署。

> 服务端只负责房间状态、权限、队列与同步事件，不做任何媒体代理。
> 音频播放能力完全来自每个听众自己的 Neiro 客户端与音源脚本。

## 功能

- ✅ 创建 / 加入房间，6 位可读房间号，昵称 1–24 位（中文/字母/数字）
- ✅ 控制者（房主）/ 听众双角色，HMAC Token 鉴权（24h）
- ✅ 邀请密钥 `joinSecret` 首次入房；成员密钥 `memberSecret` 重连不触发暂停
- ✅ 服务端权威位置推算 `expectedPositionMs`（播放中按 rate 前进、单曲循环取模回绕），客户端据此校正本地进度
- ✅ 控制事件：`PLAY` `PAUSE` `SEEK` `PLAYBACK_MODE` `SET_TRACK` `SET_QUEUE` `UPDATE_SETTINGS` `HEARTBEAT`
- ✅ 听众请求：`REQUEST_*` 系列（受 `allowMemberControl` 门控 + 目标曲目 stableKey 守卫防误切）
- ✅ 事件幂等（clientSequence 过期丢弃）、成员加入/离开自动暂停（可关）、房主离线检测与自动关房
- ✅ 本地歌曲禁止入房同步；队列上限 2000 首

## HTTP API（两平台一致）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/rooms` | 创建房间 `{nickname}` → 返回 roomId/joinSecret/memberSecret/token |
| POST | `/api/rooms/:id/join` | 加入 `{nickname, secret}`（secret=joinSecret 或 memberSecret）|
| GET | `/api/rooms/:id/state` | 房间快照（Bearer Token）|
| POST | `/api/rooms/:id/control` | 提交控制事件 `{event:{type,...}}`（Bearer Token）|
| POST | `/api/rooms/:id/leave` | 显式离开（Bearer Token；房主离开即关房）|
| GET | `/api/rooms/:id/ws?token=...` | WebSocket 实时同步（仅 Cloudflare）|
| GET | `/healthz` | 健康检查 |

### 同步模型差异

| | Cloudflare | Vercel |
|---|---|---|
| 实时性 | WebSocket 推送（毫秒级） | HTTP 轮询（建议 3s） |
| 存储 | Durable Object（每房间一实例） | Upstash Redis（CAS 写入） |
| 时钟对时 | WS `np_ping`/`np_pong` | 以每次响应的 `serverNowMs` 为准 |
| 费用 | 免费档 | Vercel Hobby + Upstash 免费档 |

## 部署到 Cloudflare Workers（推荐）

```bash
cp .dev.vars.example .dev.vars   # 改成随机长密钥
npm install
npx wrangler deploy
# 生产密钥：
npx wrangler secret put LISTEN_TOGETHER_TOKEN_SECRET
```

或一键部署：[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Wxjxpp/Neiro-LIT)

## 部署到 Vercel

1. 到 [upstash.com](https://upstash.com) 创建一个免费 Redis（Regional），复制 REST URL 与 Token
2. 推入 Vercel 并配置环境变量：

```bash
npm i -g vercel && vercel link
vercel env add LISTEN_TOGETHER_TOKEN_SECRET   # 随机长字符串
vercel env add UPSTASH_REDIS_REST_URL          # https://xxx.upstash.io
vercel env add UPSTASH_REDIS_REST_TOKEN        # REST Token
vercel deploy --prod
```

3. 验证：`curl https://<你的域名>/healthz`

## 快速自测

```bash
BASE=https://your-worker.your-subdomain.workers.dev
# 创建房间
curl -s -XPOST $BASE/api/rooms -H 'Content-Type: application/json' \
  -d '{"nickname":"房主"}'
# 用返回的 joinSecret 加入
curl -s -XPOST $BASE/api/rooms/<ROOMID>/join -H 'Content-Type: application/json' \
  -d '{"nickname":"听众","secret":"<joinSecret>"}'
# 用返回的 token 发控制事件
curl -s -XPOST $BASE/api/rooms/<ROOMID>/control \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"event":{"type":"PLAY","positionMs":0}}'
```

## 协议要点（客户端接入必读）

### 房间快照（脱敏后）

```jsonc
{
  "schemaVersion": 1,
  "roomId": "AB23CD",
  "version": 12,
  "controllerId": "mxxxxxxxxxxxx",
  "closed": false,
  "members": { "m...": { "nickname": "房主", "role": "controller", ... } },
  "playback": {
    "track": { "stableKey": "wy:123", "songId": "123", "sourceId": "wy",
               "title": "...", "artist": "...", "durationMs": 240000 },
    "queue": [ /* 同上 */ ], "currentIndex": 0,
    "playing": true, "basePositionMs": 30000, "anchoredAtMs": 1700000000000,
    "rate": 1, "repeatMode": 2, "shuffleEnabled": false
  },
  "settings": { "allowMemberControl": true, "autoPauseOnMemberChange": true },
  "serverNowMs": 1700000010000,
  "expectedPositionMs": 40000,
  "controllerOnline": true
}
```

### 进度校正算法（客户端）

```text
offset = serverNowMs - clientNowMs            // 每次收到快照时估算时钟差
localExpected = expectedPositionMs + (now - snapshotTime) * rate
若 |本地进度 - localExpected| > 800ms → seek(localExpected)，否则继续自然播放
```

### 曲目稳定键

`stableKey = "${sourceId}:${songId}"`。Neiro 的在线歌曲 `MediaLocation.Remote(sourceId, songId)` 可直接映射；**本地歌曲没有稳定键，禁止入房**（服务端会拒绝 `sourceId=local`）。

### 与 Neiro 客户端的对接

Neiro 已定义传输层契约 `core/together/TogetherTransport.kt`（Noop 占位）。本仓库即其参考实现之一：

- Cloudflare 后端 → `WsTogetherTransport`（WebSocket + np_ping 对时 + 推送）
- Vercel 后端 → `PollingTogetherTransport`（轮询 state + control 提交）

事件映射：`TogetherEvent.Play/Pause/Seek ↔ PLAY/PAUSE/SEEK`，`QueueChanged ↔ SET_QUEUE`。

## 测试

```bash
npm test   # 协议核心单测（加入/重连/权限/位置推算/幂等/脱敏/Token）
```

## 致谢

- [cwuom/NeriPlayer](https://github.com/cwuom/NeriPlayer) — 一起听客户端协议设计
- [TheSmallHanCat/NeriPlayer-LTW](https://github.com/TheSmallHanCat/NeriPlayer-LTW) — Workers + DO 服务端参考
