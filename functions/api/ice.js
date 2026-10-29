export async function onRequestGet({ request, env }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const fail = (msg, status) =>
    new Response(JSON.stringify({ error: msg }), { status, headers });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return fail("forbidden", 403);

  if (!env.METERED_DOMAIN || !env.METERED_API_KEY) return fail("relay not configured", 500);

  const domain = env.METERED_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const res = await fetch(
    `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`,
  );
  if (!res.ok) return fail("relay error " + res.status, 502);

  const iceServers = await res.json();
  if (!Array.isArray(iceServers) || !iceServers.length) return fail("relay returned nothing", 502);
  return new Response(JSON.stringify({ iceServers }), { headers });
}
