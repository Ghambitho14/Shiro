# Despliegue y operación (Shiro)

## Variables de entorno (servidor web)

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto HTTP (por defecto `1406`). |
| `BIND_HOST` | Interfaz de escucha; `127.0.0.1` en local, `0.0.0.0` en Docker o red. |
| `SHIRO_AUTH_TOKEN` | Contraseña de la web (`Authorization: Bearer <token>`). Si `BIND_HOST` no es local y falta, se genera una al arrancar y se muestra en el log. `off` = sin contraseña (úsalo solo si `BIND_HOST` es una red de confianza, p. ej. la IP de Tailscale). |
| `SHIRO_LLM_PROVIDER` | `ollama`, `ollama-cloud`, `lmstudio`, `llamacpp`, `gguf` (llama.cpp integrado), `vllm`, `openrouter`, `opencode`, `opencode-go` o `custom`. |
| `SHIRO_LLM_BASE_URL` | URL del servidor del modelo (en Docker, Ollama del host: `http://host.docker.internal:11434`). |
| `SHIRO_LLM_MODEL` | Nombre del modelo. |
| `SHIRO_LLM_API_KEY` | API key (o `OLLAMA_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY` / `VLLM_API_KEY`). |
| `WA_ALLOWED_CHAT` | Chat de WhatsApp con acceso completo; sin él, solo herramientas públicas. |
| `SHIRO_SYSTEM_ROOT` | Raíz permitida para herramientas de sistema (opcional). |
| `SHIRO_DATA_DIR` | Carpeta de datos en vez de `data/` del proyecto (opcional). |

La configuración persistente del asistente vive en `data/config.json` (modelo, proveedor, `maxToolIterations`, `skillPaths`, etc.).

## Datos que deben persistir

Directorio `data/`:

- `config.json` — ajustes de la app.
- `chat-index.sqlite` y `chats/` — historial de sesiones (si `persistChatHistory` no es `false`).
- `workspace/` — la memoria del asistente (SOUL.md, MEMORY.md, TOOLS.md, `Sobre mí.md`, `Instrucciones.md`,
  `Agentes/`, `Recuerdos/`) y las habilidades. Con Obsidian, la memoria está en la carpeta `Shiro/` de la bóveda.
- Estado de WhatsApp u otros módulos según lo que uses.

En Docker, la carpeta `./data` (junto a `docker-compose.yml`) se monta en `/app/data`: para llevar
tus chats y ajustes a un servidor, copia ahí `config.json`, `chat-index.sqlite`, `chats/`, `workspace/`
y `state.json`. No copies `browser-profile/` ni `cache/` (son de Windows).

## Docker

```bash
docker compose up -d --build
```

- La contraseña de la web y las claves van en `.env` junto a `docker-compose.yml` (`SHIRO_AUTH_TOKEN=...`).
- El contenedor corre como el usuario `node` (uid 1000), así `./data` sigue siendo del usuario normal del servidor.
- La imagen usa `npm ci`: `package-lock.json` debe estar al día.
- Ollama en el mismo servidor: `http://host.docker.internal:11434`.
- Control del PC (teclado, ratón, capturas) solo funciona en Windows; en Docker la terminal usa bash.

## Endpoints relevantes

- `GET /` — UI web.
- `POST /api/chat` — respuesta JSON única.
- `POST /api/chat/stream` — mismos cuerpo y reglas que `/api/chat`, respuesta `text/event-stream` (eventos `start`, `delta`, `done`, `error`).
- `PATCH /api/chat-sessions/:id` — body `{ "title": "Nuevo nombre" }`.

## Seguridad

No expongas `BIND_HOST=0.0.0.0` sin `SHIRO_AUTH_TOKEN` en entornos no confiables.

Servidor con Tailscale, sin contraseña y con HTTPS (el micrófono del navegador solo funciona en HTTPS):

1. `docker-compose.override.yml` junto a `docker-compose.yml` con `network_mode: host`, `ports: !reset []`
   y `BIND_HOST=127.0.0.1` (Shiro solo escucha dentro del servidor; no necesita contraseña).
2. `sudo tailscale serve --bg --yes 1406`: Tailscale lo publica en `https://<equipo>.<tailnet>.ts.net`
   con certificado válido, solo para tu tailnet. Shiro acepta ese nombre `*.ts.net`.
