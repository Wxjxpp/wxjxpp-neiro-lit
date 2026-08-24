/**
 * Neiro-LIT · URL 音源可用性探测（Cloudflare Workers / Vercel 共享）
 *
 * 提交加歌时调用，确保「传上去就能播」：
 * - 发 HEAD（多数音频 CDN 支持），失败或被拒时回退 Range GET（只取 2KB）；
 * - 校验 HTTP 状态 < 400 与 Content-Type/Content-Length 启发式；
 * - 超时 5s 判定不可用；m3u8/HLS 允许 text/* 或无 Content-Type。
 */
export const PROBE_TIMEOUT_MS = 5000
const AUDIO_EXT_RE = /\.(mp3|flac|m4a|aac|ogg|opus|wav|ape|wma|m3u8)(\?|$)/i

/**
 * 探测 URL 是否为可用音源。
 * @returns {{ok: boolean, status?: number, contentType?: string, reason?: string}}
 */
export async function probeAudioUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl).trim())
  } catch {
    return { ok: false, reason: 'URL 无法解析' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http(s)' }
  }
  // 内网地址防护：避免 SSRF 打到内网服务
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) ||
      url.hostname === '[::1]') {
    return { ok: false, reason: '不允许内网地址' }
  }
  // 1) HEAD 优先（省流量）
  try {
    const r = await fetch(url.toString(), {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': 'NeiroLIT-Probe/2.0' },
    })
    if (r.ok) {
      const verdict = judgeResponse(r)
      if (verdict.ok) return { ...verdict, status: r.status }
    } else if (r.status === 405 || r.status === 501) {
      // 不支持 HEAD → 回退 GET
    } else {
      return { ok: false, status: r.status, reason: `HTTP ${r.status}` }
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { ok: false, reason: '探测超时(5s)' }
    }
    // 网络错误 → 尝试 GET 兜底
  }
  // 2) Range GET 兜底（只取头部 2KB，够判断可用性）
  try {
    const r = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Range: 'bytes=0-2047', 'User-Agent': 'NeiroLIT-Probe/2.0' },
    })
    if (!r.ok && r.status !== 206) {
      return { ok: false, status: r.status, reason: `HTTP ${r.status}` }
    }
    // 读一小段确认流可读后立即取消
    try {
      const reader = r.body?.getReader()
      if (reader) {
        await reader.read()
        reader.cancel().catch(() => {})
      }
    } catch { /* 流读不了但状态 OK 也算过（部分实现不吐 body） */ }
    return { ...judgeResponse(r), status: r.status }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { ok: false, reason: '探测超时(5s)' }
    }
    return { ok: false, reason: '无法连接' }
  }
}
function judgeResponse(r) {
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const len = Number(r.headers.get('content-length') || 0)
  const cr = (r.headers.get('content-range') || '').toLowerCase()
  const isHls = ct.includes('mpegurl') || ct.includes('m3u')
  const looksLikeAudio = ct.startsWith('audio/') || ct === 'application/ogg' || ct === 'binary/octet-stream'
  const unknownType = !ct || ct.startsWith('text/') || ct.includes('octet-stream') || ct.includes('application/json')
  const sizeOk = len === 0 || len > 1024 || cr.includes('bytes')
  if (sizeOk === false) return { ok: false, contentType: ct, reason: '文件异常（过小）' }
  // 有音频 MIME 直接过；未知类型看扩展名；HTML 直接拒（大概率是防盗链页）
  if (looksLikeAudio) return { ok: true, contentType: ct }
  if (ct.includes('text/html')) return { ok: false, contentType: ct, reason: '返回的是网页而非音频（可能有防盗链）' }
  if (isHls) return { ok: true, contentType: ct }
  if (unknownType && AUDIO_EXT_RE.test(new URL(r.url || '').pathname)) return { ok: true, contentType: ct }
  if (unknownType) return { ok: true, contentType: ct } // 宽松放行：很多直链不给准确 CT
  return { ok: false, contentType: ct, reason: `不支持的类型 ${ct}` }
}