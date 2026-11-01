// Email recovery for ChatSpace (runs inside the Cloudflare Worker).
//
//   POST /api/recovery/send-code   (logged in)  email a code to confirm your recovery email
//   POST /api/recovery/confirm     (logged in)  check that code
//   POST /api/recovery/request     (logged out) email a password-reset code
//   POST /api/recovery/reset       (logged out) check the code and set a new password
//
// Secrets this needs (Cloudflare dashboard > your Worker > Settings > Variables and Secrets):
//   SUPABASE_SERVICE_ROLE_KEY   your Supabase "secret" key. NEVER put this in config.js.
// plus ONE way of sending email:
//   Option A, Gmail (free, no domain needed):
//     GMAIL_USER                a Gmail address, for example chatspace.app@gmail.com
//     GMAIL_APP_PASSWORD        a Google "App password" for that account (not its normal password)
//   Option B, Brevo (best when you own a domain):
//     BREVO_API_KEY             your Brevo API key
//     MAIL_FROM_EMAIL           the sender address you verified in Brevo

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MAX_ATTEMPTS = 5;
const BAD_CODE = "That code isn't right or has expired.";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function recoveryResponse(request, env, route) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: "forbidden" }, 403);
  const canMail =
    (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) ||
    (env.BREVO_API_KEY && env.MAIL_FROM_EMAIL);
  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_PUBLISHABLE_KEY ||
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    !canMail
  )
    return json({ error: "Email recovery isn't switched on yet." }, 501);
  if (Number(request.headers.get("Content-Length") || 0) > 4096)
    return json({ error: "Request too large." }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const ctx = { env, supa: env.SUPABASE_URL.replace(/\/+$/, "") };
  try {
    switch (route) {
      case "send-code":
        return await sendVerifyCode(request, ctx, body);
      case "confirm":
        return await confirmVerifyCode(request, ctx, body);
      case "request":
        return await requestReset(ctx, body);
      case "reset":
        return await finishReset(ctx, body);
      default:
        return json({ error: "Not found." }, 404);
    }
  } catch (err) {
    console.error("recovery", route, err?.message);
    return json({ error: "Something went wrong. Try again in a moment." }, 500);
  }
}

// ---------- Supabase helpers (use the secret key, so keep them server-side) ----------

function svcHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  // New-style "sb_secret_" keys go in apikey only; old service_role keys are JWTs.
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function rest(ctx, path, init = {}) {
  const res = await fetch(`${ctx.supa}/rest/v1/${path}`, {
    ...init,
    headers: { ...svcHeaders(ctx.env), ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`REST ${path.split("?")[0]} ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function signedInUser(request, ctx) {
  const token = (request.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) return null;
  const res = await fetch(`${ctx.supa}/auth/v1/user`, {
    headers: {
      apikey: ctx.env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => null);
  if (!res?.ok) return null;
  const user = await res.json().catch(() => null);
  return user?.id ? user : null;
}

const getSettings = async (ctx, userId) =>
  (
    await rest(
      ctx,
      `user_settings?user_id=eq.${userId}&select=recovery_email,recovery_email_verified`,
    )
  )?.[0] || null;

// ---------- Codes ----------

const newCode = () =>
  String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

async function hashCode(ctx, challengeId, code) {
  // Mixed with the secret key, so a leaked table alone cannot be used to guess codes.
  const data = new TextEncoder().encode(
    `${ctx.env.SUPABASE_SERVICE_ROLE_KEY}:${challengeId}:${code}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Creates a code and stores only its hash. Returns null if too many were requested.
async function issueChallenge(ctx, userId, kind, email, perHour, minutes) {
  const since = encodeURIComponent(new Date(Date.now() - HOUR).toISOString());
  const recent = await rest(
    ctx,
    `recovery_challenges?user_id=eq.${userId}&kind=eq.${kind}&created_at=gte.${since}&select=id`,
  );
  if ((recent || []).length >= perHour) return null;

  const id = crypto.randomUUID();
  const code = newCode();
  await rest(ctx, "recovery_challenges", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id,
      user_id: userId,
      kind,
      email,
      code_hash: await hashCode(ctx, id, code),
      expires_at: new Date(Date.now() + minutes * MINUTE).toISOString(),
    }),
  });
  // Tidy up anything older than a day.
  const old = encodeURIComponent(
    new Date(Date.now() - 24 * HOUR).toISOString(),
  );
  await rest(ctx, `recovery_challenges?expires_at=lt.${old}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => {});
  return code;
}

// Checks a code. Each code gets 5 tries and works once.
async function checkChallenge(ctx, userId, kind, code, email) {
  const now = encodeURIComponent(new Date().toISOString());
  const rows = await rest(
    ctx,
    `recovery_challenges?user_id=eq.${userId}&kind=eq.${kind}&used=eq.false&expires_at=gt.${now}&order=created_at.desc&limit=1&select=*`,
  );
  const c = rows?.[0];
  if (!c) return { ok: false };
  if (c.attempts >= MAX_ATTEMPTS) return { ok: false, tooMany: true };
  if (email && c.email !== email) return { ok: false };

  const patch = (data) =>
    rest(ctx, `recovery_challenges?id=eq.${c.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(data),
    });

  if (!safeEqual(await hashCode(ctx, c.id, code), c.code_hash)) {
    await patch({ attempts: c.attempts + 1 });
    return { ok: false };
  }
  await patch({ used: true });
  return { ok: true };
}

// ---------- Email (Brevo) ----------

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

async function sendCodeEmail(ctx, to, subject, intro, code, outro) {
  const text = `${intro}\n\n${code}\n\n${outro}`;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;color:#111">
        <p>${esc(intro)}</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:18px 0">${esc(code)}</p>
        <p style="color:#555">${esc(outro)}</p></div>`;

  if (ctx.env.GMAIL_USER && ctx.env.GMAIL_APP_PASSWORD)
    return sendViaGmail(ctx, { to, subject, text, html });

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": ctx.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: "ChatSpace", email: ctx.env.MAIL_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}`);
}

// ---------- Gmail over SMTP (a tiny client, no libraries) ----------

const b64Text = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin)
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
};

function buildMime({ from, to, subject, text, html }) {
  const boundary = "cs_" + crypto.randomUUID().replace(/-/g, "");
  return [
    `From: ChatSpace <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@chatspace.app>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Text(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Text(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function sendViaGmail(ctx, { to, subject, text, html }) {
  const user = String(ctx.env.GMAIL_USER).trim();
  const pass = String(ctx.env.GMAIL_APP_PASSWORD).replace(/\s+/g, "");
  // Tests supply a fake connection; in production this is Cloudflare's TCP API.
  const connect =
    ctx.env._smtpConnect || (await import("cloudflare:sockets")).connect;

  // Port 465 = encrypted from the first byte (port 25 is blocked on Workers).
  const socket = connect(
    { hostname: "smtp.gmail.com", port: 465 },
    { secureTransport: "on" },
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = "";

  async function readReply() {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          buffer = lines.slice(i + 1).join("\r\n");
          return Number(lines[i].slice(0, 3));
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP connection closed early");
      buffer += dec.decode(value, { stream: true });
    }
  }
  // The error names the step, never the line sent (it can hold the login).
  async function step(line, okCodes, label) {
    await writer.write(enc.encode(line + "\r\n"));
    const code = await readReply();
    if (!okCodes.includes(code))
      throw new Error(`SMTP ${label} was refused (${code})`);
  }

  try {
    if ((await readReply()) !== 220) throw new Error("SMTP greeting failed");
    await step("EHLO chatspace.app", [250], "greeting");
    await step("AUTH LOGIN", [334], "login start");
    await step(btoa(user), [334], "username");
    await step(btoa(pass), [235], "password");
    await step(`MAIL FROM:<${user}>`, [250], "sender");
    await step(`RCPT TO:<${to}>`, [250, 251], "recipient");
    await step("DATA", [354], "data");
    // A line that starts with "." must be doubled, then the message ends with "." alone.
    const body = buildMime({ from: user, to, subject, text, html }).replace(
      /^\./gm,
      "..",
    );
    await writer.write(enc.encode(body + "\r\n.\r\n"));
    if ((await readReply()) !== 250)
      throw new Error("SMTP message was refused");
    await writer.write(enc.encode("QUIT\r\n")).catch(() => {});
  } finally {
    try {
      socket.close();
    } catch {}
  }
}

const maskEmail = (e) => {
  const [name, domain = ""] = e.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
};

// ---------- Routes ----------

async function sendVerifyCode(request, ctx, body) {
  const user = await signedInUser(request, ctx);
  if (!user) return json({ error: "Please log in again." }, 401);
  let settings = await getSettings(ctx, user.id);

  // The app sends the email you typed, and the server saves it itself, so this
  // step never depends on an earlier "Save" having reached the database.
  const typed = String(body?.email || "")
    .trim()
    .toLowerCase();
  if (typed) {
    if (typed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(typed))
      return json({ error: "Enter a valid email address." }, 400);
    if (settings?.recovery_email !== typed) {
      await rest(ctx, "user_settings?on_conflict=user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: user.id,
          recovery_email: typed,
          recovery_email_verified: false,
        }),
      });
      settings = { recovery_email: typed, recovery_email_verified: false };
    }
  }
  if (!settings?.recovery_email)
    return json({ error: "Type your recovery email first." }, 400);
  if (settings.recovery_email_verified)
    return json({ ok: true, already: true });

  const code = await issueChallenge(
    ctx,
    user.id,
    "verify_email",
    settings.recovery_email,
    5,
    15,
  );
  if (!code)
    return json(
      { error: "Too many codes requested. Try again in an hour." },
      429,
    );
  await sendCodeEmail(
    ctx,
    settings.recovery_email,
    "Confirm your ChatSpace recovery email",
    "Use this code to confirm your recovery email. It works for 15 minutes.",
    code,
    "If you didn't ask for this, you can ignore this email.",
  );
  return json({ ok: true, sentTo: maskEmail(settings.recovery_email) });
}

async function confirmVerifyCode(request, ctx, body) {
  const user = await signedInUser(request, ctx);
  if (!user) return json({ error: "Please log in again." }, 401);
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code))
    return json({ error: "Enter the 6-digit code." }, 400);
  const settings = await getSettings(ctx, user.id);
  if (!settings?.recovery_email)
    return json({ error: "Save a recovery email first." }, 400);

  const result = await checkChallenge(
    ctx,
    user.id,
    "verify_email",
    code,
    settings.recovery_email,
  );
  if (!result.ok)
    return json(
      {
        error: result.tooMany
          ? "Too many tries. Ask for a new code."
          : BAD_CODE,
      },
      result.tooMany ? 429 : 400,
    );

  await rest(
    ctx,
    `user_settings?user_id=eq.${user.id}&recovery_email=eq.${encodeURIComponent(settings.recovery_email)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ recovery_email_verified: true }),
    },
  );
  return json({ ok: true });
}

const cleanUsername = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();
const validUsername = (u) => /^[a-z0-9_]{3,24}$/.test(u);

async function findUser(ctx, username) {
  const rows = await rest(
    ctx,
    `profiles?username=eq.${encodeURIComponent(username)}&select=id`,
  );
  return rows?.[0]?.id || null;
}

// Always answers the same way, so nobody can use it to find out which usernames exist.
async function requestReset(ctx, body) {
  const generic = json({ ok: true });
  const username = cleanUsername(body.username);
  if (!validUsername(username)) return generic;

  const userId = await findUser(ctx, username);
  if (!userId) return generic;
  const settings = await getSettings(ctx, userId);
  if (!settings?.recovery_email || !settings.recovery_email_verified)
    return generic;

  const code = await issueChallenge(
    ctx,
    userId,
    "reset",
    settings.recovery_email,
    3,
    10,
  );
  if (code) {
    try {
      await sendCodeEmail(
        ctx,
        settings.recovery_email,
        "Your ChatSpace password reset code",
        "Use this code to reset your ChatSpace password. It works for 10 minutes.",
        code,
        "If you didn't ask for this, ignore this email. Your password has not changed.",
      );
    } catch (err) {
      console.error("mail", err?.message);
    }
  }
  return generic;
}

async function finishReset(ctx, body) {
  const fail = (status = 400) => json({ error: BAD_CODE }, status);
  const username = cleanUsername(body.username);
  const code = String(body.code || "").trim();
  const password = String(body.newPassword || "");
  if (password.length < 8 || password.length > 72)
    return json({ error: "Use a password with 8 to 72 characters." }, 400);
  if (!validUsername(username) || !/^\d{6}$/.test(code)) return fail();

  const userId = await findUser(ctx, username);
  if (!userId) return fail();
  const settings = await getSettings(ctx, userId);
  if (!settings?.recovery_email || !settings.recovery_email_verified)
    return fail();

  const result = await checkChallenge(
    ctx,
    userId,
    "reset",
    code,
    settings.recovery_email,
  );
  if (!result.ok)
    return result.tooMany
      ? json({ error: "Too many tries. Ask for a new code." }, 429)
      : fail();

  const res = await fetch(`${ctx.supa}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: svcHeaders(ctx.env),
    body: JSON.stringify({ password }),
  });
  if (!res.ok)
    return json({ error: "Couldn't set the new password. Try again." }, 502);
  return json({ ok: true });
}
