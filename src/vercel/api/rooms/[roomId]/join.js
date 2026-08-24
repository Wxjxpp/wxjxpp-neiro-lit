import { handleJoin } from '../../_lib.js'
export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  const { roomId } = request.query
  return handleJoin(request, String(roomId))
}
