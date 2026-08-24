import { handleCreateRoom } from './_lib.js'
export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  return handleCreateRoom(request)
}
