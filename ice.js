// Cloudflare Pages Function: GET /api/ice
// Hands the browser short-lived TURN relay credentials.
// Needs two secrets set in Cloudflare: TURN_KEY_ID and TURN_API_TOKEN.
export async function onRequestGet({ request, env }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  // Only answer requests coming from your own site.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });

  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN)
    return new Response(JSON.stringify({ error: "relay not configured" }), { status: 500, headers });

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }),
    },
  );
  if (!res.ok)
    return new Response(JSON.stringify({ error: "relay error " + res.status }), { status: 502, headers });

  const data = await res.json();
  // Drop port 53 URLs: browsers block them and print warnings.
  const iceServers = [].concat(data.iceServers || []).map((s) => ({
    ...s,
    urls: [].concat(s.urls).filter((u) => !u.includes(":53")),
  }));
  return new Response(JSON.stringify({ iceServers }), { headers });
}
