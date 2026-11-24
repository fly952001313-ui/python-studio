// No caches or workspace data: only a scoped, one-shot interactive-input rendezvous.
const pending = new Map(),
  early = new Map();
const response = (data) =>
  new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const valid = (id) => typeof id === "string" && /^[a-f0-9-]{36}-\d+$/.test(id);
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
function complete(id, data) {
  const entry = pending.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(response(data));
  }
}
self.addEventListener("message", (e) => {
  const { id, value, cancel, session } = e.data || {};
  if (cancel) {
    if (typeof session !== "string") return;
    for (const key of pending.keys())
      if (key.startsWith(session + "-")) complete(key, { eof: true });
    for (const key of early.keys())
      if (key.startsWith(session + "-")) {
        clearTimeout(early.get(key).timer);
        early.delete(key);
      }
    return;
  }
  if (!valid(id) || typeof value !== "string" || value.length > 1000000) return;
  if (pending.has(id)) complete(id, { value });
  else {
    if (early.size > 100) return;
    const timer = setTimeout(() => early.delete(id), 310000);
    early.set(id, { value, timer });
  }
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname !== new URL("__input__", self.registration.scope).pathname
  )
    return;
  const id = url.searchParams.get("id");
  if (!valid(id)) {
    e.respondWith(response({ eof: true }));
    return;
  }
  e.respondWith(
    new Promise((resolve) => {
      if (early.has(id)) {
        const entry = early.get(id);
        clearTimeout(entry.timer);
        early.delete(id);
        resolve(response({ value: entry.value }));
      } else {
        const timer = setTimeout(() => complete(id, { eof: true }), 305000);
        pending.set(id, { resolve, timer });
      }
    }),
  );
});
