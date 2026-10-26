# Shiro

Asistente personal de IA con herramientas (búsqueda web, archivos, recordatorios, memoria),
que **controla tu PC** (abrir apps y webs, música y volumen, ventanas, teclado, ratón,
capturas de pantalla, apagar/bloquear) y con el que puedes **hablar por voz**.
Funciona con **modelos locales** (archivos GGUF con llama.cpp integrado, Ollama, LM Studio, vLLM) o en la nube
(OpenRouter, OpenCode Zen, suscripción OpenCode Go). Se usa desde su propia ventana (estilo ChatGPT), la terminal
WhatsApp o Telegram, y también **dentro de OpenCode** como servidor MCP.

## Empezar (con Ollama, gratis y local)

1. Instala [Node.js 22+](https://nodejs.org) y [Ollama](https://ollama.com).
2. Descarga un modelo que sepa usar herramientas:
   ```bash
   ollama pull qwen3:8b
   ```
3. Instala Shiro:
   ```bash
   npm install
   ```
4. Ábrelo en su propia ventana:
   ```bash
   npm start
   ```
   La primera vez, entra en **Ajustes** (abajo a la izquierda) → **Modelo** para elegirlo y
   pulsa "Probar conexión". Todo se configura ahí: ya no hay asistente en la terminal.
   Para tener un icono en el escritorio: `npm run app -- --acceso-directo`.
   También puedes usar la terminal (`npm run tui`) o el navegador (`npm run dev` → http://127.0.0.1:1406).

### Archivos GGUF sin Ollama (llama.cpp integrado)

En **Ajustes → Modelo** elige "llama.cpp integrado (archivos GGUF)":

1. Pulsa **Descargar llama.cpp** (una sola vez). Shiro baja la versión oficial de
   [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp): CUDA si tienes una NVIDIA, si no Vulkan.
   Queda en `data/llama.cpp/`.
2. Elige un modelo de la lista. Shiro encuentra solo los de **LM Studio**, los que ya bajaste con **Ollama**
   (sin descargarlos otra vez) y los `.gguf` que copies a `data/models/` o a las carpetas que añadas.
3. Listo: con el primer mensaje Shiro abre llama.cpp, carga el modelo en la tarjeta gráfica y lo cierra
   al salir. Si pasan 10 minutos sin mensajes, libera la memoria de la tarjeta (se puede cambiar).

### Ajustes de cada modelo

En **Ajustes → Modelo → "Ajustes de <modelo>"** se cambia, para ese modelo o para todos:

- **Cómo responde:** temperatura, si "piensa" antes de responder (Qwen3 y otros) y el largo máximo.
- **Contexto:** con llama.cpp, "Automático" usa el mayor que cabe en la tarjeta; con Ollama, el `num_ctx`.
- **Rendimiento (llama.cpp):** capas en la tarjeta, memoria del contexto comprimida (el doble de contexto),
  hilos del procesador y flash attention.
- **Herramientas:** nativas o como texto, pocas o todas, pasos máximos y tiempo de espera.

Cada modelo guarda solo lo que cambies; lo demás sigue a los ajustes generales.
Si juegas o usas otros programas que gastan la tarjeta gráfica, llama.cpp irá más lento: pulsa
"Liberar la tarjeta ahora" o baja el contexto.

## Shiro.exe (Windows)

Para tener Shiro como un programa normal, sin abrir la terminal ni instalar Node.js en otros equipos:

```bash
npm run exe
```

Crea `dist/Shiro.exe` (~120 MB, con su icono): un solo archivo con todo Shiro dentro. Ábrelo con doble
clic. `Shiro.exe --acceso-directo` crea además un icono en el escritorio. Para crearlo hace falta Node.js
25.5 o más nuevo; para usarlo, nada (el modelo sí: Ollama, LM Studio o uno en la nube).

- **Tus datos no van dentro del .exe**. Si al lado del .exe hay una carpeta `data`, usa esa (copia ahí la
  `data` de este proyecto para llevarte tu configuración y tus chats). Si no, usa `%APPDATA%\Shiro` y la
  primera vez sale la bienvenida.
- **Instalador**: `npm run instalador` crea `dist/ShiroSetup-<versión>.exe` (~30 MB). Instala Shiro para tu
  usuario (sin permisos de administrador) con icono en el menú Inicio (y en el escritorio si lo marcas), y se
  desinstala desde Configuración → Aplicaciones (tus datos en `%APPDATA%\Shiro` se quedan). Hace falta
  [Inno Setup 6](https://jrsoftware.org/isinfo.php): `winget install --id JRSoftware.InnoSetup -e --scope user`.
- Si ya tienes otro Shiro abierto (por ejemplo `npm run dev`, con tus datos del proyecto), el .exe no lo usa:
  abre el suyo en otro puerto (1407…).
- Mientras Shiro está abierto se ve su consola (minimizada si lo abres con el acceso directo): ciérrala
  para apagarlo.
- Para actualizarlo, vuelve a ejecutar `npm run exe` (con Shiro cerrado) y reemplaza el .exe.
- Si lo pasas a otro PC, Windows puede avisar "Windows protegió su PC" porque el .exe no está firmado:
  **Más información → Ejecutar de todas formas**.
- También sirve para lo demás: `Shiro.exe tui`, `Shiro.exe mcp` (OpenCode), `Shiro.exe --help`.

## La aplicación

- **Bienvenida**: la primera vez te pregunta cómo te llamas, qué debe saber de ti, cómo se llamará
  tu asistente, **dónde guarda tus cosas** y qué modelo usar. Se repite desde Ajustes → General.
- **Dónde se guardan tus cosas** (Ajustes → Datos): en este equipo, en tu bóveda de **Obsidian**
  (chats, recuerdos y recordatorios como notas en la carpeta `Shiro`, y busca en todas tus notas) o en
  **Supabase** (varios equipos con los mismos chats: pega el SQL que te da Shiro en el SQL Editor y usa la
  clave secreta). Al cambiar, "Llevar mis datos" copia lo que ya tenías.
- **Chat estilo ChatGPT**: historial agrupado por fecha con búsqueda, renombrar, exportar
  y borrar; respuestas en directo con formato (código resaltado, tablas); botón **Detener**;
  editar y reenviar tus mensajes; regenerar respuestas; copiar; adjuntar imágenes y
  archivos de texto (botón +, arrastrar o pegar); tema claro/oscuro; se adapta al móvil.
- **Lo que hace en cada momento**: bajo cada respuesta ves los pasos ("Abriendo Spotify ✓",
  "Buscando en internet…") y las capturas de pantalla que tomó.
- **Permisos en la misma conversación**: antes de algo delicado aparece una tarjeta
  *Permitir / Permitir siempre en este chat / Rechazar*.
- **Selector de modelo** arriba: lista los modelos de tu proveedor y cambia con un clic.
- **Ajustes** (abajo a la izquierda): modelo, voz, control del PC, permisos, tu perfil, WhatsApp y Telegram.
- **Telegram** (Ajustes → Conexiones): crea un bot con @BotFather (`/newbot`), pega el token y pulsa
  Conectar. Escríbele `/start` desde Telegram y pulsa **Autorizar** en Ajustes: solo responde a los
  chats que autorices (cualquiera puede encontrar un bot). Funciona mientras Shiro esté abierto.
- Atajos: `Ctrl+Mayús+O` nuevo chat · `Ctrl+K` buscar · `Ctrl+Mayús+Espacio` modo voz · `Esc` detener.

## Voz

- **Dictar**: el botón del micrófono escribe lo que dices en el cuadro de texto.
- **Modo voz** (botón de ondas): conversación manos libres. Shiro te escucha, responde
  en voz alta frase a frase mientras piensa, y vuelve a escuchar. Toca el círculo para
  interrumpirlo. Si necesita permiso para algo, te lo pregunta y puedes decir "sí" o "no".
- Por defecto usa el reconocimiento y las voces **del navegador** (Edge o Chrome; no hay
  que instalar nada, pero el reconocimiento necesita internet). En Edge hay voces
  "naturales" muy buenas: elígela en Ajustes → Voz.
- Para voz **100 % local o de más calidad**, en Ajustes → Voz elige "Servidor" y pon la
  dirección de un servidor compatible con OpenAI:
  - Reconocimiento (Whisper): [speaches](https://github.com/speaches-ai/speaches) en tu PC
    (`http://localhost:8000/v1`), o Groq (`https://api.groq.com/openai/v1`, modelo `whisper-large-v3-turbo`).
  - Voz: [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) en tu PC
    (`http://localhost:8880/v1`, modelo `kokoro`, voz española `ef_dora`), o OpenAI.

## Control del PC (Windows)

Pídeselo con tus palabras, por escrito o por voz:

| Qué | Ejemplos |
|---|---|
| Abrir apps, webs, carpetas y archivos | "abre Spotify", "pon lofi en YouTube", "abre mis descargas" |
| Música y volumen | "sube el volumen", "pon el volumen al 30", "siguiente canción", "pausa" |
| Ventanas | "¿qué tengo abierto?", "cierra el Bloc de notas", "minimiza todo" |
| Teclado y ratón | "escribe un saludo en el Bloc de notas", "haz clic en Aceptar" (con modelos que ven imágenes) |
| Estado del equipo | "¿cuánta RAM estoy usando?", "¿cuánto espacio me queda?", "¿cuánta batería?" |
| Programas | "¿qué está consumiendo memoria?", "cierra Chrome que se colgó" |
| Energía | "bloquea el PC", "apaga el PC en 30 minutos", "cancela el apagado" |

- **Siempre pide permiso** para: escribir con el teclado, hacer clic, leer el portapapeles,
  ejecutar programas o comandos, cerrar programas a la fuerza y apagar/reiniciar/suspender.
  Abrir apps, cambiar el volumen o mirar el estado no pide permiso.
- Apagar y reiniciar esperan 1 minuto por defecto: da tiempo a decir "cancela el apagado".
- Para "ver" la pantalla (y hacer clic en sitios concretos) el modelo debe aceptar imágenes:
  `qwen2.5vl`, `gemma3`, `llama3.2-vision`, o modelos en la nube como `gpt-4o-mini`.
  Shiro lo detecta por el nombre (Ajustes → Modelo → Visión).
- El control del PC solo está disponible desde la ventana de Shiro y la terminal (donde
  puedes aprobar acciones), nunca desde WhatsApp o Telegram. Se puede apagar entero en
  Ajustes → Control del PC (`pcControl: false`).

### ¿Qué modelo local elijo?

| Tu PC | Modelo recomendado |
|---|---|
| 8 GB de RAM/VRAM | `qwen3:4b` o `llama3.2:3b` |
| 16 GB | `qwen3:8b` (recomendado) |
| 24 GB o más | `qwen3:14b`, `qwen3:30b-a3b`, `gpt-oss:20b` |

Con modelos locales, Shiro usa automáticamente un set reducido de herramientas
(`toolProfile: "auto"`) para que el modelo no se confunda. Si un modelo no soporta
herramientas, Shiro cambia solo a "modo texto".

## Habilidades

Instrucciones especializadas (carpetas con un `SKILL.md`, el mismo formato que Claude Code,
Codex u OpenCode). En **Ajustes → Habilidades**:

- **Habilidades de Shiro**: crea las tuyas ("cómo resumir mis correos", "cómo escribo los
  informes"…), importa un `SKILL.md` o copia carpetas en `data/workspace/skills`.
- **Usar habilidades de otras aplicaciones**: Shiro encuentra solo las que tengas en Claude Code
  (`~/.claude/skills`), otros agentes (`~/.agents/skills`), Codex, GitHub Copilot, OpenCode y
  LM Studio, y las usa sin que tengas que activar nada. Cada aplicación tiene su interruptor; toca
  la fila para ver sus habilidades y apagar las que no quieras. Las que vienen incluidas con la
  propia aplicación (`~/.claude/skills/synced`, `~/.codex/skills/.system`) empiezan apagadas,
  porque suelen necesitar herramientas que solo tiene esa aplicación.
- Shiro solo le pasa al modelo la lista (nombre y descripción). Cuando una encaja, el modelo
  la carga con la herramienta `use_skill`. Para forzar una, escribe `/nombre lo que quieras`.

## Conectores MCP

Shiro se conecta a servidores MCP y usa sus herramientas (navegador, archivos, GitHub,
Notion, bases de datos…). En **Ajustes → Conectores MCP**:

- **Agregar servidor**: un programa de tu PC (`npx -y @playwright/mcp@latest`) o una URL
  remota, con variables de entorno o cabeceras para las claves. Hay ejemplos listos.
- **Importar** los servidores que ya tengas en LM Studio, Claude Desktop, Claude Code,
  Cursor, VS Code u OpenCode, o **editar `mcp.json`** directamente (mismo formato que
  LM Studio o Claude Desktop, se guarda en `data/mcp.json`).
- Cada servidor muestra si está conectado, sus herramientas y su registro. Puedes apagar
  herramientas sueltas o marcarlas "Sin preguntar".
- Sus herramientas **siempre piden permiso** (salvo las marcadas "Sin preguntar"), y solo se
  ofrecen donde se puede pedir permiso: la ventana y la terminal, nunca WhatsApp o Telegram.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` / `npm run app` | Abre Shiro en su propia ventana (`npm run app -- --acceso-directo` crea el icono del escritorio) |
| `npm run tui` | Chat en la terminal |
| `npm run dev` | Solo el servidor web (en el navegador). Se reinicia solo cuando cambia el código |
| `npm run wa` | Puente de WhatsApp |
| `npm run doctor` | Diagnóstico del modelo (`-- --fix` aplica lo recomendado) |
| `npm run mcp` | Shiro como servidor MCP (para OpenCode, Claude Code, Cursor...): en Claude Code, `claude mcp add shiro -- node <ruta>/bin/shiro-mcp.mjs` |
| `npm run ayuda` | Lista de comandos |
| `npm test` / `npm run check` | Pruebas / revisión de tipos |

`npm run config`, `npm run onboard` y `npm run personalize` ya no existen: todo eso está en Ajustes.

**En el chat** (web y terminal), escribe `/` para ver el menú:

| Comando | Qué hace |
|---|---|
| `/ayuda` | Lista de comandos |
| `/nuevo` | Empezar una conversación nueva |
| `/estado` | Modelo, herramientas, habilidades y MCP |
| `/modelo [nombre]` | Ver el modelo o cambiarlo |
| `/habilidades` | Habilidades activas |
| `/mcp` | Servidores MCP y sus herramientas |
| `/herramientas on\|off` | Activar o desactivar las herramientas |
| `/explica off\|breve\|on` | Que diga qué herramientas usó |
| `/<habilidad> texto` | Responder usando esa habilidad |

## Claude Code (con tu suscripción de Claude)

En un **Proyecto** con la carpeta de tu código vinculada, Shiro puede encargarle tareas de
programación a [Claude Code](https://docs.claude.com/claude-code): «pídele a Claude Code que arregle
el error del login». Usa tu plan de Claude (Pro incluye Claude Code), no la API.

1. Instala Claude Code y entra una vez: `claude` → `/login`.
2. Vincula la carpeta del código a un proyecto de Shiro y habla en un chat de ese proyecto.

Pide permiso antes de cada encargo, enseña su progreso en el panel Terminal (el botón de parar lo
detiene), puede cambiar archivos de esa carpeta y solo ejecuta los comandos que hayas permitido en
Claude Code. `npm run doctor` dice si lo encuentra. Más en `docs/claude-code.md`.

## Usar Shiro con OpenCode

Hay dos formas, y se pueden combinar:

**1. Shiro dentro de OpenCode (MCP).** OpenCode puede usar la memoria, los recordatorios
y la búsqueda web de Shiro. Copia `opencode.example.json` como `opencode.json`
(en tu proyecto o en `~/.config/opencode/opencode.json`), cambia la ruta de
`bin/shiro-mcp.mjs` por la tuya, y ábrelo en OpenCode. El ejemplo también configura
OpenCode para usar Ollama local.

**2. Modelos de OpenCode dentro de Shiro (Zen o suscripción Go).**
1. Copia tu API key de https://opencode.ai/auth (con la suscripción Go activa si vas a usar Go).
2. En la ventana de Shiro ve a Ajustes → Modelo y elige "OpenCode Go (suscripción)"
   (u "OpenCode Zen" si pagas por uso).
3. Deja la dirección como está, pega la API key y elige el modelo (p. ej. `glm-5.3-flash` o `kimi-k3`).
4. Pulsa "Probar conexión" para comprobar que responde.

Shiro descarga el catálogo de modelos de OpenCode y usa el formato correcto de cada uno
(Kimi, GLM, DeepSeek, MiniMax, GPT, Grok...); solo los modelos Gemini no funcionan todavía.
Para no escribir la ruta de `bin/shiro-mcp.mjs` a mano, cópiala de Ajustes → Conectores MCP →
"Shiro como servidor MCP".

## Seguridad

- Las acciones peligrosas (ejecutar comandos, escribir fuera del workspace, `git push`,
  modificar el código de Shiro, teclado/ratón, apagar el PC...) **piden permiso**: en la
  terminal con s/n, en la web con una tarjeta (y en modo voz, diciendo "sí" o "no").
  Configurable con `approvalMode` (`ask` | `allow` | `deny`) y `execAllowlist`
  (comandos que no preguntan, p. ej. `["git", "npm"]`).
- "Permitir siempre en este chat" solo existe para abrir cosas, teclado, ratón y
  portapapeles; se olvida al reiniciar Shiro. Comandos y apagar se preguntan siempre.
- Por WhatsApp no se puede aprobar nada: esas acciones se bloquean. Sin
  `WA_ALLOWED_CHAT`, Shiro solo usa herramientas públicas (web, hora, calculadora) y no
  ve tu memoria ni «Sobre ti»: cualquiera que te escriba podría pedírsela.
- Las herramientas del modelo (`fetch_url`, el navegador) no pueden leer la propia web de Shiro.
- La web solo escucha en tu PC. Si la abres a la red (`BIND_HOST=0.0.0.0`) exige
  contraseña (`SHIRO_AUTH_TOKEN`, o se genera una y se muestra en la terminal).

## Configuración

Se cambia desde Ajustes y se guarda en `data/config.json` (los servidores MCP, en
`data/mcp.json`). Las variables de
entorno de `.env.example` tienen prioridad. Campos principales:

| Campo | Para qué |
|---|---|
| `llmProvider`, `llmModel`, `llmBaseUrl`, `llmApiKey` | Qué modelo usar |
| `contextWindow` | Memoria del modelo en tokens (Ollama). 8192 por defecto |
| `toolMode` | `auto` / `native` / `text` |
| `toolProfile` | `auto` / `lite` / `full` (cuántas herramientas ve el modelo) |
| `approvalMode`, `execAllowlist` | Permisos (ver Seguridad) |
| `pcControl` | `true` / `false`: herramientas para controlar el PC |
| `vision` | `auto` / `on` / `off`: si el modelo puede ver imágenes y capturas |
| `sttEngine`, `sttBaseUrl`, `sttModel`, `sttApiKey` | Reconocimiento de voz (`browser` o `server`) |
| `ttsEngine`, `ttsBaseUrl`, `ttsModel`, `ttsVoice`, `ttsApiKey` | Voz de Shiro (`browser` o `server`) |
| `disabledSkillSources` | Aplicaciones cuyas habilidades NO se usan (`claude`, `agents`, `codex`, `copilot`, `opencode`, `lmstudio`); el resto se usan solas |
| `disabledSkills`, `enabledSkills`, `skillPaths` | Habilidades apagadas una a una / incluidas con otra app que encendiste / carpetas extra de habilidades |
| `role` | `default`, `dev`, `analyst`, `hacker` |
| `storage`, `obsidianVault`, `supabaseUrl`, `supabaseKey` | Dónde se guardan chats, recuerdos y recordatorios (Ajustes → Datos) |
| `setupDone` | La bienvenida ya se hizo |

Despliegue con Docker: ver [DEPLOY.md](DEPLOY.md).
