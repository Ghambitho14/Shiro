// Service worker mínimo: permite instalar Shiro como aplicación (Edge/Chrome).
// No guarda nada en caché: Shiro siempre necesita su servidor local.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
