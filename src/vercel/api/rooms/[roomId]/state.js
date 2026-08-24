import { handleState } from '../../_lib.js'
export default async function handler(request) {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  return handleState(String(request.query.roomId))
}
