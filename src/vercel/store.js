/**
 * Neiro-LIT · Vercel 存储层（Upstash Redis REST）
 *
 * 免费档即可运行：https://upstash.com → Create Database (Regional) → REST。
 * 环境变量：UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_URL_TOKEN（见 Vercel 控制台）。
 *
 * 并发模型：
 * - 房态整体存为一个 JSON（key = lit:room:<ID>），带 version 字段；
 * - 写入用 EVAL Lua 脚本做「版本比对 + 原子替换」（CAS），
 *   失败时调用方重新读-改-写，保证多实例并发下不丢更新；
 * - 键设 24h TTL，每次写入刷新；房主长时间离线由请求路径惰性关房。
 */

export class RoomStore {
  /**
   * @param url Upstash REST 地址
   * @param token Upstash REST Token
   */
  constructor(url, token) {
    this.url = (url || '').replace(/\/$/, '')
    this.token = token || ''
  }

  async cmd(...args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`upstash http ${res.status}`)
    const data = await res.json()
    if (data.error) throw new Error(`upstash: ${data.error}`)
    return data.result
  }

  key(roomId) { return `lit:room:${roomId}` }

  async get(roomId) {
    const raw = await this.cmd('GET', this.key(roomId))
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  /**
   * 原子更新：readModify(oldState|null) 返回新状态或 null（放弃写入）。
   * 冲突时自动重试（最多 5 次）。
   */
  async update(roomId, readModify) {
    const k = this.key(roomId)
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.cmd('GET', k)
      let current = null
      if (raw) {
        try { current = JSON.parse(raw) } catch { current = null }
      }
      const next = await readModify(current ? structuredClone(current) : null)
      if (!next) return { ok: true, unchanged: true }
      const expectVer = current ? String(current.version ?? -1) : '-1'
      // Lua CAS：期望版本匹配才写入；'-1' 表示要求房间不存在（创建）
      const result = await this.cmd(
        'EVAL',
        `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '-1' then
  if cur then return 0 end
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[1], 86400)
  return 1
end
if not cur then return -1 end
local ok, v = pcall(function() return cjson.decode(cur).version end)
if not ok or v ~= tonumber(ARGV[1]) then return -2 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], 86400)
return 1
`,
        '1', k, expectVer, JSON.stringify(next),
      )
      if (result === 1) return { ok: true, state: next }
      // 版本冲突或已存在：循环重读重试
    }
    throw new Error('并发冲突，请重试')
  }

  async delete(roomId) {
    await this.cmd('DEL', this.key(roomId))
  }
}