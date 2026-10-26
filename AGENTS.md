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

- `src/index.ts` — punto de entrada y subcomandos (`app`, `web`, `tui`, `wa`, `doctor`, `mcp`). La configuración se hace en Ajustes de la web (ya no hay `config`/`onboard`/`personalize`).
- `src/app.ts` — `npm run app`: arranca el servidor y abre la web en ventana propia (Edge/Chrome `--app`); crea el acceso directo. Si ya hay un Shiro abierto más viejo que el código de `src/` (o que el .exe), lo cierra con `/api/local/shutdown` (clave en `data/cache/server-<puerto>.json`) y arranca el nuevo. `npm run dev` usa `tsx watch`.
- `src/config/config.ts` — configuración con zod (`data/config.json`); migra el formato viejo. `DATA_DIR` es `data/` o `SHIRO_DATA_DIR` (las pruebas usan una carpeta temporal); con el .exe, `data` junto al .exe o `%APPDATA%\Shiro`: los módulos lo importan de aquí, no lo calculan con `__dirname`.
- `src/runtime.ts` — si corre desde el código o desde `Shiro.exe` (`IS_EXE`), `APP_DIR`, `APP_VERSION`, `resolveDataDir()`. Los archivos de la app (`public/`, librerías de `/vendor/`, el wasm de sql.js, `package.json`) se leen SIEMPRE con `readAppFile("public/...")`: dentro del .exe no existen en disco. Nada de `import.meta.url`/`__dirname`/`createRequire` para rutas (en el .exe apuntan al propio .exe).
- `src/buildExe.ts` — `npm run exe`: esbuild junta todo en un .mjs, los archivos van como assets de Node SEA (`node --build-sea`, Node 25.5+), y a una copia de node.exe se le pone el icono y el nombre de Shiro (C# con `UpdateResource`). Sale `dist/Shiro.exe`; `npm run instalador` además lo empaqueta con Inno Setup 6 (`installer/shiro.iss`, por usuario en `%LOCALAPPDATA%\Programs\Shiro`) en `dist/ShiroSetup-<versión>.exe`. Con el .exe, `app.ts` no reutiliza un Shiro ajeno en el 1406 (otra carpeta de datos): usa el siguiente puerto libre. `public/` entra entero; cualquier otro archivo del proyecto que el código lea hay que añadirlo en `collectAssets()`.
- `src/storage/` — dónde se guardan las cosas del usuario (`storage` en config: `local`, `obsidian`, `supabase`): `storage.ts` (ajustes activos, `testStorage`), `obsidian.ts` (notas en `<bóveda>/Shiro`: `Chats/`, `Recuerdos/`, `Recordatorios.md` y el workspace; bóvedas de `obsidian.json`; Shiro no lee ni busca fuera de esa carpeta), `supabase.ts` (PostgREST con `fetch`, tablas `shiro_*` con RLS, `SUPABASE_SQL`, errores en español), `migrate.ts` ("Llevar mis datos"; SOUL.md/TOOLS.md/MEMORY.md ya cambiados en el destino no se pisan: a MEMORY.md se le añade lo que falta). Chats en `src/chat/backends.ts` (memoria/local/Obsidian = local + nota/Supabase); recuerdos en `src/core/memory/memories.ts` (`memory_add`/`memory_search`: palabras clave + embeddings si hay; `memory_add` con `important` también apunta en `MEMORY.md`); recordatorios en `src/core/reminders/reminders.ts` (asíncronos); `src/workspace.ts` `getWorkspaceDir()` (con Obsidian, la carpeta Shiro de la bóveda; las habilidades siguen en `data/workspace/skills`). La memoria son `MEMORY.md` (siempre en el system prompt) y los recuerdos; `buildMemoryGuide()` le dice al modelo dónde están según Ajustes → Datos (sin eso, con Obsidian creía que la bóveda era algo aparte).
- `src/storageApi.ts` — API de Ajustes → Datos y de la bienvenida (`/api/storage`, `/api/storage/test`). La clave de Supabase nunca va al navegador (`hasSupabaseKey`).
- `src/core/llm/` — conexión con modelos:
  - `providers.ts` presets (ollama, lmstudio, llamacpp, gguf, vllm, openrouter, opencode, custom) y `resolveLLMSettings()`.
    `prepareLLM()` (antes de cada petición) baja el catálogo de OpenCode o abre el llama.cpp integrado; los presets `managed` (gguf) no tienen dirección ni API key.
  - `modelSettings.ts` ajustes de cada modelo (temperatura, pensar, largo máximo, contexto, rendimiento de llama.cpp, herramientas, pasos, espera): `config.modelSettings["<proveedor>|<modelo>"]` (solo lo que difiere) → generales (campos sueltos de la config) → por defecto. Para leerlos: `getModelTuning()` o `activeModelTuning()` (providers.ts), nunca `getConfig().toolProfile` y similares. API `src/modelSettingsApi.ts` (`/api/model-settings`), web `public/js/modelSettings.js`.
  - `modelList.ts` `listProviderModels()`: los modelos de un proveedor (Ollama `/api/tags`, OpenAI `/models`, catálogo de OpenCode, GGUF del equipo) con errores en español; la clave guardada solo va a la dirección guardada. `GET /api/models` (el guardado) y `POST /api/models` (el del formulario, sin guardar).
  - `transports.ts` una "vuelta" con el modelo: dialecto OpenAI (`/chat/completions`) u Ollama nativo (`/api/chat`, para fijar `num_ctx`). Streaming incluido.
  - `client.ts` bucle de herramientas, streaming y cambio automático a modo texto.
  - `textTools.ts` formato `<tool_call>{json}</tool_call>` para modelos sin tools nativas.
  - `getLLM.ts` `getLLM()` (el modelo de Ajustes) y `getLLMFor(perfil)` (el de un agente: `ModelRef` de `providers.ts`, cliente de `createLLMClientFor`; sin modelo propio es el de Ajustes).
  - `modelGate.ts` un solo modelo local cargado a la vez (Ollama, LM Studio, GGUF): `acquireModel(gateTarget(...))` → vuelta → `release`; el mismo modelo pasa sin esperar, otro espera a que acaben las vueltas en curso y descarga el anterior (`/api/ps` + `keep_alive: 0` en Ollama, `/api/v1/models/unload` en LM Studio, cerrar `llama-server`). Los de la nube y servidores propios no esperan. `client.ts` lo hace en cada vuelta.
- `src/core/llamacpp/` — llama.cpp integrado (proveedor `gguf`): `models.ts` (archivos GGUF de `data/models`, LM Studio, los blobs de Ollama leyendo sus manifiestos y `ggufFolders`; mmproj = visión), `install.ts` (descarga `llama-server` de las versiones de GitHub de ggml-org: CUDA según el driver de NVIDIA + `cudart`, si no Vulkan/CPU; comprueba sha256; extrae con el `tar.exe` de Windows; `data/llama.cpp/install.json`), `engine.ts` (un solo `llama-server` en 127.0.0.1 con puerto libre y clave aleatoria por `LLAMA_API_KEY`; contexto automático = sin `-c` (`--fit` elige el mayor que quepa) y el real se lee de `/props`; se reinicia si cambian modelo/contexto/rendimiento; `--sleep-idle-seconds` libera la GPU; `data/cache/llama-server.json` para que otro proceso de Shiro lo reutilice; registro en `data/llama.cpp/llama-server.log`, errores traducidos en `explainFailure`). `src/llamacppApi.ts` — `/api/llamacpp*` (estado, descarga, liberar, carpetas). Web: `public/js/llamacpp.js` (panel dentro de `modelForm.js`).
- `src/core/agent/Agent.ts` — `runAgent()`: arma el contexto, elige tools (perfil lite para locales; sin approver no hay tools del PC), anti-bucle, errores legibles, eventos de progreso (`onToolEvent`), cancelación (`signal`), modo voz.
- `src/core/agent/ContextBuilder.ts` — system prompt (las tools NO se listan aquí; van por la API). Añade las reglas de control del PC y del modo voz, la lista de habilidades y la habilidad pedida con `/nombre`.
  Lo que el usuario puede reescribir desde Ajustes → Personalización (`src/promptsApi.ts`, `public/js/prompts.js`): las instrucciones base (`core/soul/soul.ts`: `DEFAULT_SYSTEM_PROMPT` con `{{nombre}}`, `{{usuario}}`, `{{carpeta}}`, `{{fecha}}`; lo cambiado va en `config.systemPrompt`) y las notas `SOUL.md`, `TOOLS.md` y `MEMORY.md` del workspace (`EDITABLE_NOTES`/`readNote`/`writeNote` en `workspace.ts`). Todo tiene su texto por defecto y se puede restaurar.
- `src/core/skills/SkillLoader.ts` — habilidades (`SKILL.md`): las de Shiro (`data/workspace/skills`) y las de otras apps (`EXTERNAL_SKILL_SOURCES`: `~/.claude/skills`, `~/.codex/skills`…), que se usan solas salvo las apagadas (`disabledSkillSources`/`disabledSkills`); las incluidas con la app (`builtIn`: `synced`, `.system`) empiezan apagadas (`enabledSkills`). Al modelo solo va la lista; el contenido lo carga con la tool `use_skill` (solo lectura, no sale de la carpeta de la habilidad).
- `src/core/mcp/` — cliente MCP: `mcpConfig.ts` (`data/mcp.json`, formato `mcpServers` de LM Studio/Claude, importar de otras apps) y `McpManager.ts` (conexiones stdio/HTTP/SSE; sus tools se ofrecen como `mcp__<servidor>__<tool>`).
- `src/core/pc/` — control de Windows: `pc.ts` (acciones), `powershell.ts` (ejecuta PowerShell pasando los datos por variables de entorno, nunca dentro del código), `nativeHelper.ts` (C# compilado una vez a `data/cache`: teclado, ratón, ventanas, volumen, capturas), `keys.ts` (atajos → teclas).
- `src/core/browser/` — navegador propio de Shiro (tool `browser`, panel "Navegador"): `browser.ts` (Chrome/Edge sin ventana con puppeteer-core y perfil en `data/browser-profile`; imagen en vivo por CDP screencast; si el perfil ya está abierto se conecta a él por `DevToolsActivePort`), `pageModel.ts` (URL/búsqueda, lectura de la página con elementos numerados `data-shiro-ref`; el script de la página va como texto, no como función, porque tsx le añade `__name`), `findBrowser.ts`.
- `src/core/terminal/terminal.ts` — terminal compartida (tool `terminal`, panel "Terminal"): una PowerShell abierta entre comandos; cada comando va en base64 y termina con una marca aleatoria (código de salida y carpeta). Sin claves en el entorno.
- `src/panelsApi.ts` — API de los paneles (`/api/browser/*`, `/api/terminal/*`, con SSE).
- `src/core/projects/` — Proyectos (como los de ChatGPT/Claude): `projects.ts` (`data/projects/<id>/project.json` con nombre, instrucciones, carpetas vinculadas y chats; copias subidas en `files/`; siempre en este equipo, sea cual sea Ajustes → Datos; rutas del modelo con prefijo `Subidos/…` o `<carpeta>/…` por `resolveProjectPath`; proyecto activo con `runWithProject`), `documents.ts` (texto de txt/código, PDF con `unpdf` y Word .docx con `mammoth`). La tool `project` (`modules/project.ts`: list/read/search/write) solo se ofrece en chats de un proyecto; el system prompt lleva sus instrucciones y la lista de archivos (y el contenido si es pequeño). `src/projectsApi.ts` — `/api/projects*` (subida binaria por archivo, selector de carpetas de Windows solo desde este PC: `core/pc/pickFolder.ts`, compartido con llama.cpp).
- `src/core/agents/` — agentes de las salas (Viernes, Lunes…): `registry.ts` (`data/agents.json` validado con zod: nombre, alias, modelo propio o el de Ajustes, forma de ser `persona` que se añade (`add`) o reemplaza (`replace`) las instrucciones base, herramientas `inherit`/`none`/lista, `mcp`, `mode` texto o voz, voz, saludo y color; rechaza nombres reservados o que se confunden entre sí), `text.ts` (`normalizeText`: sin tildes, mayúsculas ni puntuación).
- `src/core/rooms/` — salas (un chat con varios agentes): `roomStore.ts` (`data/rooms/<id del chat>.json`, siempre en este equipo; `pruneRoom` quita los agentes borrados), `roomIntent.ts` (órdenes con palabras y sin modelo: «Aku, activa Viernes», «agrega a Lunes», «puedes irte», «ahora te encargas tú», y quién responde: el nombrado o el principal), `roomLogic.ts` (qué cambia y la respuesta fija de cada orden), `roomHistory.ts` (historial para el agente que responde: lo suyo como `assistant`, lo de los demás como «[Nombre]: …»; recorta sin quitar el último mensaje del usuario), `roomTurn.ts` (compartido por web y terminal: `planRoomTurn()` decide si hay respuesta fija o `responder`; `prepareAgentTurn()` da `llm`, `agentName`, `persona`, `room`, `conversation`, `allowedTools` y `mcp` para `runAgent`). Los mensajes guardados llevan `agent`/`agentName` (solo respuestas del asistente con id válido, `sanitizeMessages` de `ChatStore.ts`). La forma de ser y el bloque «## Sala» los añade `ContextBuilder.ts`.
- `src/agentsApi.ts` — `/api/agents*` (Ajustes → Agentes: crear, editar, probar modelo, borrar) y `/api/rooms*` (barra de participantes, «Abrir sala» con `openRoomChat()`). El chat de `server.ts` aplica las órdenes de sala, un turno a la vez por sala, y borra la sala al borrar el chat.
- `src/core/tools/ToolRegistry.ts` — definiciones de tools (`TOOLS`), `LITE_TOOLS`, `executeToolSafeScoped()`.
- `src/core/tools/tools.ts` — implementación de las tools; `schemas.ts` valida argumentos con zod.
- `src/core/tools/approval.ts` — aprobación de acciones peligrosas (`describeRiskyAction`, approvers por interfaz).
- `src/mcp/server.ts` + `bin/shiro-mcp.mjs` — Shiro como servidor MCP (memoria, recordatorios, web).
- `src/telegram.ts` — puente de Telegram (sondeo largo `getUpdates` desde el servidor): solo responde a `telegramChats` (el resto queda como solicitud en Ajustes → Conexiones); endpoints `/api/telegram/*` en `server.ts`. El token va en la URL de la API: nunca a logs ni al navegador.
- `src/commands.ts` — comandos del chat (`/ayuda`, `/modelo`, `/habilidades`, `/mcp`…), compartidos por web y terminal; `COMMANDS` alimenta el menú de `/`.
- `src/extensionsApi.ts` — API de Ajustes → Habilidades y Ajustes → Conectores MCP (`/api/skills*`, `/api/mcp*`, `/api/commands`).
- Interfaces: `src/chat-cli.ts` (terminal; la sala vive solo en memoria, `/sala` muestra quién está y `/nuevo` la borra), `src/server.ts` + `public/` (web), `src/whatsapp.ts`.
- Web (`public/`, sin build, módulos ES): `index.html`, `css/app.css`, `js/app.js` (chat, ajustes, modo voz),
  `js/api.js` (fetch + SSE), `js/markdown.js` (marked + DOMPurify + highlight.js servidos en `/vendor/`),
  `js/voice.js` (reconocimiento del navegador o Whisper, lectura en voz alta por frases),
  `js/extensions.js` (pestañas Habilidades y Conectores MCP), `js/commands.js` (menú al escribir `/`),
  `js/setup.js` (bienvenida del primer arranque —sale si `needsSetup`: sin `setupDone` ni nombre de usuario— y el formulario de Ajustes → Datos),
  `js/modelForm.js` (formulario del modelo de Ajustes → Modelo y de la bienvenida: tarjetas de proveedores por `group` con `title`/`hint` de los presets, lista de modelos, API key solo en la nube, dirección en «avanzado»),
  `js/panels.js` (paneles Navegador y Terminal a la derecha; se abren solos cuando Shiro usa `browser`/`terminal`),
  `js/projects.js` (Proyectos: página `#/p/<id>` con archivos, instrucciones y chats; lista `#/proyectos`; sección de la barra lateral),
  `js/agents.js` (Ajustes → Agentes: formulario de cada agente, «Probar modelo» y «Abrir sala»; el nombre y color de cada respuesta y la barra de participantes están en `app.js`),
  `js/orb.js` (esfera holográfica del modo voz, canvas).
  El stream SSE envía `delta`, `tool` (inicio/fin de cada herramienta), `approval`, `room` (la sala cambió), `agent` (quién responde) y `done`.

## Reglas

- Toda tool nueva: definición en `ToolRegistry.ts`, schema en `schemas.ts`, y si tiene efectos
  (comandos, escribir fuera del workspace, red con efectos) añadirla a `describeRiskyAction`.
- No llamar a `executeTool` directamente desde interfaces: usar `executeToolSafeScoped` (aplica permisos).
- Tools de servidores MCP: no van en `TOOLS`. Solo se ofrecen si hay approver (web, terminal) y siempre
  piden permiso salvo las marcadas en `alwaysAllow`. Los valores de `env`/`headers` de `mcp.json` no se
  mandan al navegador (se enmascaran como `••••••`).
- Tools del PC: nunca interpolar datos del modelo dentro de un script de PowerShell; pasarlos como
  argumentos de `runPowerShell`/`runNative` (llegan como `$env:SHIRO_A_*`). Lo que Windows Defender
  bloquea en scripts (p. ej. capturas) va en `nativeHelper.ts`.
- Proyectos: `project` lee, lista y busca sin permiso (las carpetas las eligió el usuario); `write` pide permiso y solo escribe
  archivos de texto dentro del proyecto. No se puede vincular la raíz de un disco, la carpeta personal ni la de datos de Shiro.
- Navegador de Shiro: solo http/https y nunca la propia web de Shiro (`normalizeUrl`/`isShiroUrl`); leer y
  navegar no piden permiso, pulsar o escribir sí (puede enviar formularios con sesiones iniciadas).
  `terminal run` pide permiso como `exec`. Ambas son tools de categoría "pc" (sin approver no se ofrecen).
- llama.cpp integrado: solo se descarga del repo fijo `ggml-org/llama.cpp` (GitHub) y se lanza con `spawn` y argumentos (nunca con shell);
  escucha solo en 127.0.0.1 y con clave. `/api/llamacpp` es ruta sensible (descarga y ejecuta un programa).
- En la web, el HTML del modelo siempre pasa por `renderMarkdown` (DOMPurify); el texto del usuario con `textContent`.
- No reintentar tools automáticamente (pueden tener efectos); solo se reintenta la llamada al modelo.
- En modo MCP, stdout es del protocolo: nada de `console.log` (usar stderr).
- Rutas nuevas de la API: añadirlas a `isSensitivePath()` (`src/server.ts`).
- Salas: el modelo de un agente se obtiene con `getLLMFor(perfil)`, nunca con `getLLM()` (ese es siempre el de Ajustes).
  Cada vuelta con un modelo local pasa por `acquireModel` de `modelGate.ts` (ya lo hace `client.ts`): no crear clientes que se lo salten.
  Las órdenes de sala se contestan sin modelo; la lógica va en `roomTurn.ts` para que web y terminal no la dupliquen.
- Mensajes al usuario en español; errores claros, nunca respuestas de relleno que oculten un fallo.
