# Despliegue y operación (Shiro)

## Variables de entorno (servidor web)

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto HTTP (por defecto `1406`). |
| `BIND_HOST` | Interfaz de escucha; `127.0.0.1` en local, `0.0.0.0` en Docker o red. |
| `SHIRO_AUTH_TOKEN` | Si está definido, rutas sensibles exigen `Authorization: Bearer <token>`. |
| `OPENROUTER_API_KEY` | Clave para OpenRouter (si `llmProvider` es `openrouter`). |
| `VLLM_BASE_URL` | URL base del backend vLLM/OpenAI-compatible. |
| `VLLM_MODEL` | Nombre del modelo en vLLM. |
| `VLLM_API_KEY` | Opcional, si el backend lo exige. |
| `PICLAW_SYSTEM_ROOT` | Raíz permitida para herramientas de sistema (opcional). |

La configuración persistente del asistente vive en `data/config.json` (modelo, proveedor, `maxToolIterations`, `skillPaths`, etc.).

## Datos que deben persistir

Directorio `data/`:

- `config.json` — ajustes de la app.
- `chat-index.sqlite` y `chats/` — historial de sesiones (si `persistChatHistory` no es `false`).
- `workspace/` — SOUL.md, TOOLS.md, skills, memoria markdown.
- Estado de WhatsApp u otros módulos según lo que uses.

En Docker, monta un volumen en `/app/data` (ver `docker-compose.yml`).

## Docker

```bash
docker compose up -d --build
```

La imagen usa `npm install` en el build; asegúrate de que `package-lock.json` esté actualizado en el repo.

## Endpoints relevantes

- `GET /` — UI web.
- `POST /api/chat` — respuesta JSON única.
- `POST /api/chat/stream` — mismos cuerpo y reglas que `/api/chat`, respuesta `text/event-stream` (eventos `start`, `delta`, `done`, `error`).
- `PATCH /api/chat-sessions/:id` — body `{ "title": "Nuevo nombre" }`.

## Seguridad

No expongas `BIND_HOST=0.0.0.0` sin `SHIRO_AUTH_TOKEN` en entornos no confiables.
