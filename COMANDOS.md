# Comandos Shiro

## Principales

| Comando | Descripción |
|--------|-------------|
| `pnpm tui` | Chat con Shiro en terminal. Escribe "salir" o "exit" para terminar. |
| `pnpm run config` | Menú de configuración (modelo, vLLM, nombre, habilidades, etc.). |
| `pnpm onboard` | Configuración inicial paso a paso (primera vez). |
| `pnpm run dev` | Inicia la web de chat (servidor en http://127.0.0.1:1406). |
| `pnpm web` | Igual que `pnpm run dev`. |
| `pnpm start server` | Inicia solo el servidor web. |
| `pnpm wa` | Inicia el puente WhatsApp Web (muestra QR para enlazar). |
| `pnpm test` | Ejecuta los tests unitarios. |

## Otros

| Comando | Descripción |
|--------|-------------|
| `pnpm start` | Sin argumentos: muestra la ayuda de comandos. |
| `pnpm start set-name <nombre>` | Cambia el nombre del asistente. |
| `pnpm start greet [nombre]` | Saludo (opcional con nombre). |
| `pnpm start --help` / `-h` | Ayuda. |
| `pnpm start --version` / `-v` | Versión. |

## Subcomandos (vía start)

- `pnpm start tui` — chat en terminal
- `pnpm start config` — configuraciones
- `pnpm start onboard` — configuración inicial
- `pnpm start server` — servidor web
- `pnpm start wa` — puente WhatsApp

## Cerrar procesos en el puerto 1406

**Windows (PowerShell o CMD):**

```cmd
netstat -ano | findstr :1406
```

Anota el **PID** (última columna) y luego:

```cmd
taskkill /PID <número_PID> /F
```

O en una sola línea (PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 1406 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Linux / Mac:**

```bash
lsof -ti :1406 | xargs kill -9
```

## Variables de entorno

- `PORT` — Puerto del servidor (por defecto 1406).
- `VLLM_BASE_URL` — URL del API vLLM.
- `VLLM_MODEL` — Modelo en vLLM.
- `VLLM_API_KEY` — API key si el servidor la exige.
