export default function handler() {
  return new Response(JSON.stringify({ ok: true, service: 'neiro-lit' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
