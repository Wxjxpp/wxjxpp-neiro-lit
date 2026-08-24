import { err, verifyAuth, handleKick } from '../../_lib.js'
export default async function handler(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const url = new URL(request.url)
  const roomId = String(request.query.roomId)
  const auth = await verifyAuth(roomId, request, url)
  if (!auth || auth.roomId !== roomId.toUpperCase()) {
    return err('token 无效', 401)
  }
  return handleKick(request, roomId, auth)
}