import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-chatspace-webhook-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("CHATSPACE_WEBHOOK_SECRET");
  if (!webhookSecret || req.headers.get("x-chatspace-webhook-secret") !== webhookSecret)
    return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@chatspace.app";
  if (!supabaseUrl || !serviceKey || !publicKey || !privateKey)
    return json({ error: "Push secrets are not configured" }, 500);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const record = payload.record ?? payload;
  const conversationId = record.conversation_id;
  const senderId = record.sender_id;
  if (!conversationId || !senderId) return json({ skipped: true, reason: "Not a message insert" });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const [{ data: participants, error: participantsError }, { data: sender }] = await Promise.all([
    admin.from("conversation_participants").select("user_id").eq("conversation_id", conversationId).neq("user_id", senderId),
    admin.from("profiles").select("display_name,username").eq("id", senderId).maybeSingle(),
  ]);
  if (participantsError) return json({ error: participantsError.message }, 500);
  const recipientIds = (participants || []).map((p: any) => p.user_id);
  if (!recipientIds.length) return json({ sent: 0 });

  const [{ data: subscriptions }, { data: settings }, { data: preferences }] = await Promise.all([
    admin.from("push_subscriptions").select("user_id,endpoint,p256dh,auth").in("user_id", recipientIds),
    admin.from("user_settings").select("user_id,notifications_enabled").in("user_id", recipientIds),
    admin.from("chat_preferences").select("user_id,is_muted,is_locked").eq("conversation_id", conversationId).in("user_id", recipientIds),
  ]);
  const enabled = new Set((settings || []).filter((s: any) => s.notifications_enabled !== false).map((s: any) => s.user_id));
  const prefs = new Map((preferences || []).map((p: any) => [p.user_id, p]));
  const senderName = sender?.display_name || sender?.username || "Someone";
  const messageBody = record.content ? String(record.content).slice(0, 140) : "Sent an attachment";
  webpush.setVapidDetails(subject, publicKey, privateKey);

  let sent = 0;
  const expired: string[] = [];
  const jobs = (subscriptions || []).filter((sub: any) => {
    const pref: any = prefs.get(sub.user_id);
    return enabled.has(sub.user_id) && !pref?.is_muted;
  }).map(async (sub: any) => {
    const pref: any = prefs.get(sub.user_id);
    const body = pref?.is_locked ? "You have a new message." : messageBody;
    const notification = {
      title: pref?.is_locked ? "ChatSpace" : senderName,
      body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: `conversation-${conversationId}`, url: "/",
    };
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(notification));
      sent++;
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) expired.push(sub.endpoint);
      console.error("Push delivery failed", error?.statusCode || error?.message);
    }
  });
  await Promise.all(jobs);
  if (expired.length) await admin.from("push_subscriptions").delete().in("endpoint", expired);
  return json({ sent, expired: expired.length });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
