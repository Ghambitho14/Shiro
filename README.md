# Shiro

Asistente personal de IA con herramientas (búsqueda web, archivos, recordatorios, memoria),
que funciona con **modelos locales** (Ollama, LM Studio, llama.cpp, vLLM) o en la nube
(OpenRouter, OpenCode Zen). Se usa desde la terminal, la web o WhatsApp, y también
**dentro de OpenCode** como servidor MCP.

## Empezar (con Ollama, gratis y local)

1. Instala [Node.js 22+](https://nodejs.org) y [Ollama](https://ollama.com).
2. Descarga un modelo que sepa usar herramientas:
   ```bash
   ollama pull qwen3:8b
   ```
3. Instala y configura Shiro:
   ```bash
   npm install
   npm run onboard
   ```
4. Comprueba que todo funciona:
   ```bash
   npm run doctor
   ```
5. Chatea:
   ```bash
   npm run tui
   ```
   o abre la web con `npm run dev` → http://127.0.0.1:1406

### ¿Qué modelo local elijo?

| Tu PC | Modelo recomendado |
|---|---|
| 8 GB de RAM/VRAM | `qwen3:4b` o `llama3.2:3b` |
| 16 GB | `qwen3:8b` (recomendado) |
| 24 GB o más | `qwen3:14b`, `qwen3:30b-a3b`, `gpt-oss:20b` |

Con modelos locales, Shiro usa automáticamente un set reducido de herramientas
(`toolProfile: "auto"`) para que el modelo no se confunda. Si un modelo no soporta
herramientas, Shiro cambia solo a "modo texto".

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run tui` | Chat en la terminal |
| `npm run dev` | Web de chat |
| `npm run wa` | Puente de WhatsApp |
| `npm run config` | Menú: cambiar modelo, probar conexión |
| `npm run doctor` | Diagnóstico del modelo (`-- --fix` aplica lo recomendado) |
| `npm run mcp` | Servidor MCP (para OpenCode, Claude Code, Cursor...) |
| `npm test` / `npm run check` | Pruebas / revisión de tipos |

## Usar Shiro con OpenCode

Hay dos formas, y se pueden combinar:

**1. Shiro dentro de OpenCode (MCP).** OpenCode puede usar la memoria, los recordatorios
y la búsqueda web de Shiro. Copia `opencode.example.json` como `opencode.json`
(en tu proyecto o en `~/.config/opencode/opencode.json`), cambia la ruta de
`bin/shiro-mcp.mjs` por la tuya, y ábrelo en OpenCode. El ejemplo también configura
OpenCode para usar Ollama local.

**2. Modelos de OpenCode Zen dentro de Shiro.** En `npm run config` elige
"OpenCode Zen", pega tu API key (de https://opencode.ai/zen) y el modelo
(p. ej. `kimi-k2.6`). Solo funcionan los modelos de Zen que usan el endpoint
`/chat/completions` (los open-source: Kimi, Qwen, DeepSeek, GLM...).

## Seguridad

- Las acciones peligrosas (ejecutar comandos, escribir fuera del workspace, `git push`,
  modificar el código de Shiro...) **piden permiso**: en la terminal con s/n,
  en la web con una ventana. Configurable con `approvalMode` (`ask` | `allow` | `deny`)
  y `execAllowlist` (comandos que no preguntan, p. ej. `["git", "npm"]`).
- Por WhatsApp no se puede aprobar nada: esas acciones se bloquean. Sin
  `WA_ALLOWED_CHAT`, Shiro solo usa herramientas públicas (web, hora, calculadora).
- La web solo escucha en tu PC. Si la abres a la red (`BIND_HOST=0.0.0.0`) exige
  contraseña (`SHIRO_AUTH_TOKEN`, o se genera una y se muestra en la terminal).

## Configuración

Se guarda en `data/config.json` (la crea `npm run onboard`). Las variables de
entorno de `.env.example` tienen prioridad. Campos principales:

| Campo | Para qué |
|---|---|
| `llmProvider`, `llmModel`, `llmBaseUrl`, `llmApiKey` | Qué modelo usar |
| `contextWindow` | Memoria del modelo en tokens (Ollama). 8192 por defecto |
| `toolMode` | `auto` / `native` / `text` |
| `toolProfile` | `auto` / `lite` / `full` (cuántas herramientas ve el modelo) |
| `approvalMode`, `execAllowlist` | Permisos (ver Seguridad) |
| `role` | `default`, `dev`, `analyst`, `hacker` |

Despliegue con Docker: ver [DEPLOY.md](DEPLOY.md).
