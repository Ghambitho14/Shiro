# Guía para agentes de código (OpenCode, Claude Code, Cursor...)

Shiro es un asistente personal en TypeScript (Node 22+, ESM, ejecutado con `tsx`, sin build).
El usuario no es programador: explica los cambios en español y en términos sencillos.

## Comprobar cambios

```bash
npm run check   # tipos (tsc --noEmit)
npm test        # node:test sobre src/**/*.test.ts
```

Ambos deben pasar antes de dar un cambio por terminado.

## Mapa del código

- `src/index.ts` — punto de entrada y subcomandos (`tui`, `dev`, `wa`, `config`, `doctor`, `mcp`).
- `src/config/config.ts` — configuración con zod (`data/config.json`); migra el formato viejo.
- `src/core/llm/` — conexión con modelos:
  - `providers.ts` presets (ollama, lmstudio, llamacpp, vllm, openrouter, opencode, custom) y `resolveLLMSettings()`.
  - `transports.ts` una "vuelta" con el modelo: dialecto OpenAI (`/chat/completions`) u Ollama nativo (`/api/chat`, para fijar `num_ctx`). Streaming incluido.
  - `client.ts` bucle de herramientas, streaming y cambio automático a modo texto.
  - `textTools.ts` formato `<tool_call>{json}</tool_call>` para modelos sin tools nativas.
- `src/core/agent/Agent.ts` — `runAgent()`: arma el contexto, elige tools (perfil lite para locales), anti-bucle, errores legibles.
- `src/core/agent/ContextBuilder.ts` — system prompt (las tools NO se listan aquí; van por la API).
- `src/core/tools/ToolRegistry.ts` — definiciones de tools (`TOOLS`), `LITE_TOOLS`, `executeToolSafeScoped()`.
- `src/core/tools/tools.ts` — implementación de las tools; `schemas.ts` valida argumentos con zod.
- `src/core/tools/approval.ts` — aprobación de acciones peligrosas (`describeRiskyAction`, approvers por interfaz).
- `src/mcp/server.ts` + `bin/shiro-mcp.mjs` — servidor MCP (memoria, recordatorios, web).
- Interfaces: `src/chat-cli.ts` (terminal), `src/server.ts` + `public/index.html` (web), `src/whatsapp.ts`.

## Reglas

- Toda tool nueva: definición en `ToolRegistry.ts`, schema en `schemas.ts`, y si tiene efectos
  (comandos, escribir fuera del workspace, red con efectos) añadirla a `describeRiskyAction`.
- No llamar a `executeTool` directamente desde interfaces: usar `executeToolSafeScoped` (aplica permisos).
- No reintentar tools automáticamente (pueden tener efectos); solo se reintenta la llamada al modelo.
- En modo MCP, stdout es del protocolo: nada de `console.log` (usar stderr).
- Mensajes al usuario en español; errores claros, nunca respuestas de relleno que oculten un fallo.
