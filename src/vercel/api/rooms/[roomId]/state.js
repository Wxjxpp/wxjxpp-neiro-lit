import { handleState, verifyAuth, err } from '../../_lib.js'
export default async function handler(request) {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  const url = new URL(request.url)
  const roomId = String(request.query.roomId)
  // token 可选：带上且有效即视为心跳（刷新在线状态）
  const auth = await verifyAuth(roomId, request, url).catch(() => null)
  if (auth && auth.roomId !== roomId.toUpperCase()) return err('token 无效', 401)
  return handleState(roomId, auth)
}