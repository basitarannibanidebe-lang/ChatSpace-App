const CACHE_NAME = "chatspace-v4-push";
const APP_FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/config.js",
];

// Libraries and fonts the app needs to start while offline.
const CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)),
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (
    request.method !== "GET" ||
    (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) ||
    url.pathname.includes("/.netlify/")
  ) {
    return;
  }

  // Online: always get the newest file and keep a copy.
  // Offline: serve the saved copy.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && (response.ok || response.type === "opaque")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return (
          cached ||
          (request.mode === "navigate"
            ? caches.match("/index.html")
            : Response.error())
        );
      }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        const existing = list.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        if (existing) {
          existing.navigate(targetUrl);
          return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      body: event.data ? event.data.text() : "You have a new notification.",
    };
  }
  const title = data.title || "ChatSpace";
  const isIncomingCall = data.type === "incoming_call";
  const options = {
    body:
      data.body ||
      (isIncomingCall ? "Someone is calling you" : "You have a new message."),
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/icon-192.png",
    tag:
      data.tag ||
      (isIncomingCall ? "chatspace-incoming-call" : "chatspace-message"),
    data: { url: data.url || "/", type: data.type || "message" },
    renotify: isIncomingCall || Boolean(data.renotify),
    ...(isIncomingCall
      ? { requireInteraction: true, vibrate: [350, 180, 350, 500, 350] }
      : {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
