export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ice" && request.method === "GET")
      return iceResponse(request, env);
    if (url.pathname === "/api/ai" && request.method === "POST")
      return aiResponse(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function iceResponse(request, env) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  const fail = (msg, status) =>
    new Response(JSON.stringify({ error: msg }), { status, headers });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return fail("forbidden", 403);

  if (!env.METERED_DOMAIN || !env.METERED_API_KEY)
    return fail("relay not configured", 500);

  const domain = env.METERED_DOMAIN.replace(/^https?:\/\//, "").replace(
    /\/+$/,
    "",
  );
  const res = await fetch(
    `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`,
  );
  if (!res.ok) return fail("relay error " + res.status, 502);

  const iceServers = await res.json();
  if (!Array.isArray(iceServers) || !iceServers.length)
    return fail("relay returned nothing", 502);
  return new Response(JSON.stringify({ iceServers }), { headers });
}

// ---------------------------------------------------------------------------
// ChatSpace AI  (POST /api/ai)  -  runs on Cloudflare Workers AI (free daily allowance).
// Needs the "ai" binding in wrangler.jsonc and the SUPABASE_* variables there.
// Optional variables:  AI_MODEL (one name or a comma-separated list), AI_STT_MODEL,
//                      AI_DAILY_LIMIT (messages per person per day, default 25).
// ---------------------------------------------------------------------------

// Workers AI retires models from time to time, so these are tried in order until one works.
// Run `npx wrangler ai models list` to see what is currently available, then set AI_MODEL.
const DEFAULT_AI_MODELS = [
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];
const DEFAULT_STT_MODELS = [
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/openai/whisper",
];

const AI_SYSTEM = `You are ChatSpace AI, the assistant built into the ChatSpace messaging app.
You have two jobs: (1) guide people around ChatSpace, and (2) answer any other question like a helpful general assistant.
Be friendly, clear and brief. Most people use phones, so keep answers short unless asked for detail. Use plain text, short lists and **bold** only when it helps. Reply in the language the person writes in.

What ChatSpace has:
- Accounts use a username and password. An email is optional and can be added in the What's new screen or in Profile for password recovery.
- Chats tab: Recent, Archived and Locked lists. Tap the three dots on a chat to pin, archive, mute, lock or set a wallpaper. Locked chats need a PIN.
- New tab: start a chat by username or create a group.
- Messages: press and hold a message (right-click on a computer) to reply, react, edit, copy or delete. Swipe a message to the left to reply. You can edit your own text message until one minute after the other person has seen it. "Delete for everyone" removes it for all; "Delete for me" hides it only for you.
- Attachments up to 50 MB. The plus button sends files and photos, the camera button takes a photo, GIF opens GIFs and stickers, the mic records a voice note.
- Photo improver: after you pick or take a photo, you can auto-enhance it, adjust brightness, contrast, colour and sharpness, rotate it, and choose Original, HD or Data saver quality. Videos are sent in original quality.
- View once: switch on the dashed 1 button in the composer, then send a photo, video or voice note. The other person can open it one time and it then shows Opened. The sender can always open their own copy. Nobody can stop screenshots or a camera pointed at the screen.
- Chat scores, stages, streaks and badges: each chat earns a score. Stages are New chat, Acquaintances (50), Friends (200), Close friends (600), Best friends (1500) and Inseparable (4000). A streak grows each day both people message. There are 9 badges, shown on the Profile page.
- Calls: voice and video calls from the icons at the top of a chat.
- Profile: edit photo, name and bio, share your profile link, and see your progress. Settings: theme, interface size, full screen, notifications, privacy.
You cannot see anyone's chats or account data. If you are not sure ChatSpace has a feature, say so rather than guessing. For medical, legal or money questions, give useful general information and suggest a professional where it matters.`;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const DOC_TYPES =
  /^(application\/(pdf|vnd\.openxmlformats-officedocument\.|vnd\.ms-excel|vnd\.oasis\.opendocument\.)|text\/html)/;
const TEXT_TYPES = /^(text\/|application\/(json|xml))/;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Pull the reply text out of whichever shape the chosen model returns.
function aiText(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  if (typeof out.response === "string") return out.response;
  if (out.result && typeof out.result.response === "string")
    return out.result.response;
  const choice = out.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) return choice.map((p) => p.text || "").join("");
  if (Array.isArray(out.output)) {
    return out.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .map((c) => c.text || "")
      .join("");
  }
  return "";
}

async function aiResponse(request, env) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  const fail = (msg, status) => reply({ error: msg }, status);

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return fail("forbidden", 403);
  if (!env.AI)
    return fail(
      "The AI isn't switched on yet. Add the Workers AI binding and redeploy.",
      501,
    );
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY)
    return fail("The AI isn't configured yet (missing SUPABASE_URL).", 501);
  if (Number(request.headers.get("Content-Length") || 0) > 14 * 1024 * 1024)
    return fail("That's too much to send at once. Try smaller files.", 413);

  // 1) Only signed-in ChatSpace users may use it.
  const token = (request.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) return fail("Please log in again.", 401);
  const supa = env.SUPABASE_URL.replace(/\/+$/, "");
  const who = await fetch(`${supa}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => null);
  if (!who?.ok) return fail("Please log in again.", 401);

  // 2) Fair-use limit per person per day, so one person can't use up the free allowance.
  const limit = Math.max(1, Number(env.AI_DAILY_LIMIT) || 25);
  const quotaRes = await fetch(`${supa}/rest/v1/rpc/use_ai_quota`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ daily_limit: limit }),
  }).catch(() => null);
  if (quotaRes?.ok) {
    const quota = await quotaRes.json().catch(() => null);
    if (quota && quota.allowed === false)
      return fail(
        `You've used today's ${limit} AI messages. They reset at midnight UTC.`,
        429,
      );
  } else if (quotaRes && quotaRes.status !== 404) {
    return fail(
      "Couldn't check your AI allowance. Try again in a moment.",
      502,
    );
  } // 404 = the SQL for the allowance hasn't been run yet; allow the request.

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request.", 400);
  }

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string",
    )
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const lastUser =
    history.length && history[history.length - 1].role === "user"
      ? history.pop()
      : null;

  // 3) Voice note -> text (Whisper).
  let transcript = null;
  if (body.audio?.data) {
    let bytes;
    try {
      bytes = b64ToBytes(body.audio.data);
    } catch {
      return fail("That voice note couldn't be read.", 400);
    }
    if (bytes.length > 8 * 1024 * 1024)
      return fail("That voice note is too long. Keep it under 2 minutes.", 413);
    const models = env.AI_STT_MODEL
      ? String(env.AI_STT_MODEL)
          .split(",")
          .map((s) => s.trim())
      : DEFAULT_STT_MODELS;
    for (const model of models) {
      try {
        const input = /turbo|v3/.test(model)
          ? { audio: body.audio.data }
          : { audio: [...bytes] };
        const out = await env.AI.run(model, input);
        transcript = String(out?.text || "").trim();
        if (transcript) break;
      } catch (e) {
        console.error("stt failed", model, e?.message);
      }
    }
    if (!transcript)
      return fail(
        "I couldn't make out that voice note. Please try again or type it.",
        422,
      );
  }

  // 4) Attachments: photos go to the vision model, documents become text.
  const images = [];
  const extra = [];
  for (const a of (Array.isArray(body.attachments)
    ? body.attachments
    : []
  ).slice(0, 4)) {
    if (!a?.data || !a?.mime) continue;
    const name = String(a.name || "attachment").slice(0, 80);
    try {
      if (IMAGE_TYPES.has(a.mime)) {
        images.push(`data:${a.mime};base64,${a.data}`);
      } else if (TEXT_TYPES.test(a.mime)) {
        const text = new TextDecoder()
          .decode(b64ToBytes(a.data))
          .slice(0, 12000);
        extra.push(`File "${name}":\n${text}`);
      } else if (DOC_TYPES.test(a.mime) && env.AI.toMarkdown) {
        const converted = await env.AI.toMarkdown([
          { name, blob: new Blob([b64ToBytes(a.data)], { type: a.mime }) },
        ]);
        const item = Array.isArray(converted) ? converted[0] : converted;
        if (item?.data)
          extra.push(`File "${name}":\n${String(item.data).slice(0, 12000)}`);
        else extra.push(`(I couldn't read the file "${name}".)`);
      } else {
        extra.push(
          `(I can't read the file "${name}". I can read photos, PDFs, Office files and text files.)`,
        );
      }
    } catch (e) {
      console.error("attachment failed", name, e?.message);
      extra.push(`(I couldn't read the file "${name}".)`);
    }
  }

  const text =
    [
      transcript ? `[Voice note] ${transcript}` : null,
      lastUser?.content,
      ...extra,
    ]
      .filter(Boolean)
      .join("\n\n") || "Please look at the attachment.";
  const userContent = images.length
    ? [
        { type: "text", text },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : text;
  const messages = [
    { role: "system", content: AI_SYSTEM },
    ...history,
    { role: "user", content: userContent },
  ];

  // 5) Ask the model; fall through the list if one has been retired.
  const models = env.AI_MODEL
    ? String(env.AI_MODEL)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_AI_MODELS;
  let lastError = "";
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages,
        max_tokens: 700,
        temperature: 0.6,
      });
      const answer = aiText(out).trim();
      if (answer) return reply({ reply: answer, transcript, model });
      lastError = "empty answer";
    } catch (e) {
      lastError = String(e?.message || e);
      console.error("model failed", model, lastError);
      if (/allocation|neurons|quota|exceeded|too many/i.test(lastError))
        return fail(
          "ChatSpace AI has used its free allowance for today. Please try again tomorrow.",
          429,
        );
    }
  }
  return fail(
    "The AI couldn't answer right now. Please try again in a moment.",
    502,
  );
}
