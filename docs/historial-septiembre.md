# Cambios en Shiro: interfaz nueva, voz y control del PC

> **Historial.** Así se escribió en septiembre; algunas cosas cambiaron después.
> El estado actual está en `README.md` y `AGENTS.md`.

**Fecha:** 30 de septiembre de 2026

## Resumen

Shiro tiene ahora:

1. **Una interfaz nueva al estilo ChatGPT**, que se abre en su propia ventana, como una aplicación.
2. **Voz.** Puedes dictarle o tener una conversación hablada sin usar las manos, y te responde en voz alta.
3. **Control del PC.** Abre programas y webs, maneja el volumen y la música, las ventanas, el teclado y el ratón, hace capturas de pantalla, te dice cómo está el equipo y puede bloquearlo, apagarlo o reiniciarlo.
4. **Permisos.** Antes de hacer algo delicado te pregunta con una tarjeta en la conversación (o de viva voz en el modo voz).

---

## Cómo usarlo

Abrir Shiro en su propia ventana:

```bash
npm run app
```

Crear además un icono "Shiro" en el escritorio:

```bash
npm run app -- --acceso-directo
```

Necesitas un modelo encendido. Por ejemplo, Ollama:

```bash
ollama pull qwen3:8b
```

Para que Shiro pueda "ver" la pantalla y hacer clic en sitios concretos, el modelo tiene que aceptar imágenes. Sirven `qwen2.5vl`, `gemma3`, `llama3.2-vision`, o modelos en la nube como `gpt-4o-mini`.

Las otras formas de usarlo siguen igual: `npm run tui` (terminal), `npm run dev` (navegador, http://127.0.0.1:1406) y `npm run wa` (WhatsApp).

---

## 1. Interfaz nueva

La web anterior (`public/index.html`) se reemplazó por completo.

**Barra lateral**
- Nuevo chat, buscar chats, modo voz y recordatorios.
- Historial agrupado por fecha: Hoy, Ayer, Últimos 7 días, Últimos 30 días y por meses.
- Cada chat tiene un menú para renombrar, exportar a Markdown o eliminar (pide confirmación).
- Abajo está tu perfil, que abre los Ajustes.
- Se puede ocultar. En el móvil se abre como un cajón.

**Barra superior**
- **Selector de modelo:** lista los modelos de tu proveedor, marca el actual y permite escribir otro. También tiene "Probar conexión" y "Configurar modelo…".
- Un punto de color indica si el modelo respondió bien la última vez.
- Botón de tema claro/oscuro y menú del chat.

**Conversación**
- Las respuestas aparecen mientras se escriben, con formato:
  - títulos, listas, tablas y citas;
  - código coloreado con botón "Copiar";
  - enlaces que se abren en otra pestaña.
- **Pasos:** debajo de cada respuesta se ve lo que hizo, por ejemplo "✓ Abriendo Spotify", "✓ Buscando en internet…" o "✗ No diste permiso". Si tomó una captura de pantalla, aparece en miniatura y se puede ampliar.
- **Botón Detener:** corta la respuesta y guarda lo que ya se escribió.
- En tus mensajes: copiar y **editar y reenviar**.
- En las respuestas: copiar, **leer en voz alta** y **regenerar**.
- Si el modelo falla, se muestra el error con el motivo y un botón **Reintentar**. No se oculta con una respuesta de relleno.
- Al terminar una respuesta, la vista se mantiene al final. Si subes para leer, aparece un botón para volver abajo.

**Cuadro de texto**
- Crece solo al escribir. Enter envía y Mayús+Enter hace un salto de línea (configurable).
- Adjuntar **imágenes** y **archivos de texto** (código, .txt, .csv, .json…) de tres formas: con el botón +, arrastrándolos a la ventana o pegándolos. Las imágenes se reducen para que no pesen demasiado.
- Botón de **micrófono** (dictar) y botón de **modo voz**.
- Con el chat vacío, un saludo con tu nombre y sugerencias: "Pon música tranquila en YouTube", "¿Cómo está mi PC?", etc.

**Ajustes** (ventana con pestañas)

| Pestaña | Qué tiene |
|---|---|
| **General** | Tema, nombre del asistente, usar herramientas sí/no, enviar con Enter, atajos de teclado |
| **Modelo** | Proveedor, modelo, dirección del servidor, API key, guardar y probar conexión, visión (automático / sí / no) |
| **Voz** | Motor de reconocimiento (navegador o servidor Whisper), idioma, motor de voz (navegador o servidor), elegir voz, velocidad, probar voz, leer respuestas en voz alta |
| **Control del PC** | Activar o desactivar, qué puede hacer, nivel de permisos, comandos que se pueden ejecutar sin preguntar |
| **Personalización** | Cómo te llama, idioma, qué debe saber de ti, cómo quieres que responda |
| **Conexiones** | WhatsApp (conectar, desconectar, código QR) e instrucciones para instalar como aplicación |

**Recordatorios:** una ventana para verlos, crearlos, marcarlos como hechos y borrarlos. Cuando llega uno, sale un aviso y una notificación de Windows. Si tienes la lectura en voz alta activada, Shiro además lo dice en voz alta.

**Otros detalles**
- Tema claro/oscuro, que por defecto sigue al de Windows.
- Cada chat tiene su propia dirección (`#/c/<id>`): funcionan recargar, Atrás y Adelante.
- Se puede instalar como aplicación desde Edge o Chrome.
- Funciona sin internet: las librerías de formato se sirven desde tu PC.
- Atajos de teclado:
  - `Ctrl+Mayús+O`: nuevo chat
  - `Ctrl+K`: buscar chats
  - `Ctrl+Mayús+Espacio`: modo voz
  - `Esc`: detener la respuesta
  - `/`: ir al cuadro de texto

**Qué se quitó:** las pantallas técnicas del panel anterior (tabla de herramientas, memoria, gateway, salud y registros). La configuración del modelo, el perfil, WhatsApp y los recordatorios pasaron a Ajustes. `public/gateway.html` sigue existiendo.

---

## 2. Voz

**Dictar (botón del micrófono)**
- Lo que dices se escribe en el cuadro de texto y no se envía hasta que tú lo envías.
- Se para tocando otra vez el micrófono.

**Modo voz (botón de ondas)**
- Pantalla completa con un círculo animado que reacciona a tu voz. Tiene cinco estados: *Te escucho* → *Pensando* → *Hablando* → vuelve a escuchar, y *En pausa*.
- **Empieza a hablar antes de terminar de pensar:** lee la respuesta frase a frase mientras el modelo la escribe.
- **Tocar el círculo** interrumpe lo que está diciendo o haciendo. **Esc** o la X cierran el modo voz.
- **Botón de pausa del micrófono.**
- En este modo el modelo recibe una instrucción para contestar **corto y natural**, sin listas ni emojis.
- **Se salta el código** al leer y al final dice "Te dejé el código en la pantalla". Tampoco lee enlaces, símbolos ni emojis.
- **Permisos por voz:** dice "Necesito tu permiso para… ¿Lo hago?" y entiende "sí", "dale", "hazlo", "no", "mejor no", "cancela"… También se puede tocar Sí / No.
- Todo lo hablado queda guardado en el chat, igual que lo escrito.

**Motores de voz**
- **Navegador (por defecto):**
  - Usa el reconocimiento de Edge o Chrome, que necesita internet, y las voces de Windows.
  - En tu PC están "Microsoft Raúl" y "Microsoft Sabina" (español de México). Edge además trae voces "naturales" de mejor calidad.
  - No funciona en Firefox.
- **Servidor (opcional, para voz sin internet o de más calidad):**
  - Cualquier servidor compatible con la API de OpenAI.
  - Reconocimiento (Whisper): *speaches* en tu PC (`http://localhost:8000/v1`) o Groq.
  - Voz: *Kokoro-FastAPI* en tu PC (`http://localhost:8880/v1`, voz española `ef_dora`) u OpenAI.
  - Shiro hace de intermediario: la API key se queda en el servidor y nunca llega al navegador.

---

## 3. Control del PC (Windows)

Son 10 herramientas nuevas que el modelo puede usar:

| Herramienta | Qué hace | ¿Pide permiso? |
|---|---|---|
| `pc_open` | Abre apps por nombre (busca entre las 132 apps de tu menú Inicio, sin importar tildes), webs ("youtube.com"), carpetas ("Descargas", "Documentos", "Papelera", "Este equipo"…) o archivos | No. **Sí** si es un programa o script (.exe/.bat/.ps1… por ruta, o un script por nombre), una ruta de red o un enlace de tipo desconocido |
| `pc_screenshot` | Captura de la pantalla principal (máx. 1920 px). Se muestra en el chat y, si el modelo ve imágenes, se le envía | No |
| `pc_keyboard` | Escribe texto (con tildes, ñ y emojis) y pulsa atajos ("ctrl+c", "alt+tab", "win+d", en español o inglés). Puede traer antes al frente una ventana concreta | **Sí** (se puede permitir para todo el chat) |
| `pc_mouse` | Clic, doble clic, clic derecho, mover y desplazar. Las coordenadas son las de la última captura | Los clics **sí** (se puede permitir para todo el chat). Mover y desplazar no |
| `pc_media` | Subir, bajar o fijar el volumen exacto, silenciar, reproducir/pausar, siguiente, anterior, detener | No |
| `pc_windows` | Listar ventanas, traer al frente, minimizar, maximizar, restaurar, cerrar (con cierre normal) y mostrar el escritorio | No |
| `pc_processes` | Lista los programas que más memoria usan, o cierra uno a la fuerza | Listar no. Cerrar a la fuerza **sí** |
| `pc_clipboard` | Lee o copia texto en el portapapeles | Leer **sí** (se puede permitir para todo el chat). Copiar no |
| `pc_system` | CPU, RAM, discos, batería, tiempo encendido | No |
| `pc_power` | Bloquear, suspender, apagar, reiniciar, cerrar sesión, cancelar un apagado | Bloquear y cancelar no. Lo demás **sí, siempre** |

**Detalles importantes**
- Apagar y reiniciar esperan **1 minuto** por defecto, para que dé tiempo a decir "cancela el apagado".
- **Nunca cierra** procesos del sistema de Windows ni el propio Shiro (`node`).
- **No cierra su propia ventana por error.** El título de la ventana de Shiro siempre empieza por "Shiro" y el control de ventanas la reconoce.
- El modelo recibe instrucciones de uso: indicar siempre la ventana antes de escribir, y no apagar nada sin que se lo pidas claramente.
- Con modelos locales (perfil "lite") se ofrecen las herramientas más útiles: abrir, música, ventanas, teclado, captura, estado y energía.
- **Solo en Windows.** En Mac/Linux solo funcionan abrir cosas y el estado del equipo.

---

## 4. Seguridad

- **Tarjeta de permisos en la conversación**, en lugar de la ventanita del navegador de antes. Tiene tres opciones:
  - **Permitir**
  - **Permitir siempre en este chat:** solo existe para abrir cosas, teclado, ratón y portapapeles, y se olvida al reiniciar Shiro.
  - **Rechazar**

  Ejecutar comandos o apagar el equipo se pregunta siempre, y si no contestas en 5 minutos se rechaza.
- **El control del PC solo se ofrece donde se puede pedir tu permiso:** la ventana de Shiro y la terminal. **Nunca desde WhatsApp ni Telegram.** El puente de Telegram responde a cualquiera que escriba al bot, y así nadie de fuera puede manejar tu PC ni ver tu pantalla.
- **Sin inyección de comandos:** lo que pide el modelo nunca se mete dentro de un script de PowerShell; se pasa aparte, como datos.
- **Sin fugas por imágenes:** el chat no carga imágenes de internet puestas por el modelo (se muestran como enlace), y el HTML peligroso se elimina.
- La API key del modelo y las de voz nunca se envían al navegador.
- Se mantienen las protecciones que ya existían: el servidor solo escucha en tu PC, se rechazan peticiones de otras webs y se pide contraseña si lo abres a la red.
- Se puede apagar todo el control del PC en Ajustes → Control del PC.

---

## 5. Configuración nueva (`data/config.json`)

Se puede cambiar desde Ajustes, sin tocar el archivo.

| Campo | Valores | Para qué |
|---|---|---|
| `pcControl` | `true` (defecto) / `false` | Herramientas de control del PC |
| `vision` | `auto` (defecto) / `on` / `off` | Si el modelo puede ver imágenes. En `auto` se deduce por el nombre (llava, qwen2.5-vl, gemma3, gpt-4o, claude, gemini…) |
| `sttEngine` | `browser` (defecto) / `server` | Reconocimiento de voz |
| `sttBaseUrl`, `sttModel`, `sttApiKey` | | Servidor Whisper |
| `ttsEngine` | `browser` (defecto) / `server` | Voz de Shiro |
| `ttsBaseUrl`, `ttsModel`, `ttsVoice`, `ttsApiKey` | | Servidor de voz (TTS) |

Estas preferencias se guardan **en el navegador**, no en `config.json`: idioma de voz, voz elegida, velocidad, leer en voz alta, enviar con Enter, tema y barra lateral oculta.

---

## 6. Cambios técnicos (para programadores y agentes de código)

### Archivos nuevos

| Archivo | Qué es |
|---|---|
| `src/core/pc/pc.ts` | Todas las acciones del PC y la clasificación de "qué se quiere abrir" |
| `src/core/pc/powershell.ts` | Ejecuta PowerShell (`-EncodedCommand`, datos por `$env:SHIRO_A_*`) y compila la ayuda nativa |
| `src/core/pc/nativeHelper.ts` | Código C# que se compila una vez a `data/cache/*.dll`: teclado y ratón (SendInput), ventanas (EnumWindows), volumen (Core Audio) y capturas |
| `src/core/pc/keys.ts` | Convierte atajos ("ctrl+c", "intro", "mayús+supr") en códigos de tecla |
| `src/core/pc/pc.test.ts` | Pruebas de atajos, clasificación, permisos, visión, validación y descripciones |
| `src/core/tools/modules/pc.ts` | Ejecutores de las 10 tools `pc_*` |
| `src/core/agent/Agent.test.ts` | Pruebas: sin approver no hay tools del PC |
| `src/app.ts` | `npm run app` (ventana `--app` de Edge/Chrome) y el acceso directo del escritorio con icono |
| `public/css/app.css` | Estilos (tema claro/oscuro, responsive) |
| `public/js/app.js` | Lógica de la interfaz: chats, envío, pasos, permisos, ajustes, recordatorios, modo voz, atajos |
| `public/js/api.js` | Peticiones al servidor y lectura del stream |
| `public/js/markdown.js` | Markdown seguro (marked + DOMPurify + highlight.js) y texto limpio para leer en voz alta |
| `public/js/voice.js` | Reconocimiento (navegador o Whisper con detección de silencio), cola de voz, división en frases, sí/no |
| `public/js/icons.js` | Iconos SVG |
| `public/icons/icon-64.png`, `icon-192.png`, `icon-512.png` | Iconos de la app (hechos a partir de `Shiro.PNG`) |
| `public/manifest.webmanifest`, `public/sw.js` | Para instalar Shiro como aplicación |
| `docs/historial-septiembre.md` (antes `CAMBIOS.md`) | Este documento |

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `public/index.html` | Reescrito entero (interfaz nueva) |
| `src/server.ts` | Endpoints nuevos (ver abajo); permisos con "siempre en este chat"; cancelación al cortar la conexión; eventos de herramientas en el stream; flag `voice`; `serverReady` para `npm run app`; decodificación de URLs que no rompe el servidor; archivos estáticos solo si son archivos |
| `src/core/agent/Agent.ts` | `onToolEvent`, `signal` (cancelar), `voice`; las capturas se envían al modelo solo si tiene visión; tools del PC solo con approver y con `pcControl` activo; `resolveTools` exportada |
| `src/core/agent/ContextBuilder.ts` | Bloques "Control del PC" y "Modo voz" en el system prompt |
| `src/core/llm/client.ts` | Las imágenes que devuelven las tools van al modelo en un mensaje aparte; solo se conserva la última captura; se detiene si se cancela |
| `src/core/llm/transports.ts`, `LLMClient.ts` | Nuevo tipo de error `cancelled` ("Respuesta detenida"), distinto del timeout |
| `src/core/llm/providers.ts` | `modelSupportsVision()` |
| `src/core/tools/ToolRegistry.ts` | Las 10 tools `pc_*` (categoría `pc`), `PC_TOOLS`, `LITE_TOOLS` ampliado, `describeToolUse()` (frases como "Abriendo Spotify") |
| `src/core/tools/schemas.ts` | Validación de las tools `pc_*`; los números aceptan texto ("50") |
| `src/core/tools/approval.ts` | Reglas de permiso de las tools `pc_*` y `REMEMBERABLE_TOOLS` |
| `src/core/tools/tools.ts`, `toolExecutors.ts`, `src/core/agent/Types.ts` | Registro de ejecutores; los resultados pueden llevar `image` |
| `src/chat/ChatStore.ts` | Los mensajes guardan `ts` (hora) y `tools` (pasos) |
| `src/config/config.ts` | Campos nuevos (sección 5) |
| `src/index.ts` | Subcomando `app` y ayuda actualizada |
| `package.json` / `package-lock.json` | Script `app` y dependencias `marked`, `dompurify` y `@highlightjs/cdn-assets` (ya instaladas) |
| `README.md`, `AGENTS.md` | Documentación de todo lo nuevo |
| `.npmrc` (borrado) | Obligaba a npm a usar `bash`. En PowerShell eso es el Ubuntu de WSL, que no tiene Node, así que `npm run dev` fallaba con `node: command not found`. Sin él, npm usa la terminal normal de Windows (y `sh` en Linux/Mac) |

### Endpoints nuevos del servidor

| Método y ruta | Qué hace |
|---|---|
| `GET /api/settings`, `PUT /api/settings` | Ajustes de la web. Las API keys nunca se devuelven. Al guardar una key: `""` la mantiene y `null` la borra |
| `GET /api/models` | Modelos disponibles en el proveedor actual (Ollama `/api/tags` u OpenAI `/models`) |
| `POST /api/voice/transcribe?lang=` | Recibe audio y lo pasa a Whisper (`/audio/transcriptions`) |
| `POST /api/voice/speak` | Recibe texto y devuelve audio del servidor TTS (`/audio/speech`) |
| `GET /api/screenshots/:archivo` | Capturas hechas por `pc_screenshot` (solo archivos `.jpg` de esa carpeta) |
| `GET /vendor/:archivo` | Librerías del navegador. Lista cerrada: nada más de `node_modules` |
| `POST /api/approvals/:id` | Ahora acepta `{ approved, remember }` |
| `POST /api/chat/stream` | Ahora acepta `voice: true` |

### Eventos del stream (SSE)

- `delta`: texto.
- `tool`: fase `start` con `label`, o fase `end` con `ok`, `error` e `image`.
- `approval`: `id`, `tool`, `summary`, `canRemember`.
- `done`
- `error`

---

## 7. Pruebas

**Automáticas**
- `npm run check`: sin errores de tipos.
- `npm test`: **49 pruebas, todas pasan** (antes había 40). Las 9 nuevas cubren atajos de teclado, qué se abre, qué pide permiso, detección de visión, validaciones, descripciones, reglas del system prompt y que las tools del PC no aparecen sin approver.

**Probado en tu PC (solo lectura, sin tocar nada)**
- Estado del equipo: Ryzen 5 3600, 24 GB de RAM, disco C:, tiempo encendido.
- Lista de ventanas abiertas y lectura del volumen (90 %).
- Búsqueda de apps: encontró Spotify, Chrome, Discord, Visual Studio Code y Steam.
- Lista de procesos por memoria.
- Captura de pantalla (0,4 s; unos 300 KB).
- Acceso directo e icono, creados en una carpeta temporal para no tocar tu escritorio.

**Probado en la interfaz, con un modelo simulado**
- Respuesta en directo con formato.
- Pasos de herramientas y tarjeta de permisos: la rechacé y la acción no se ejecutó.
- Botón Detener.
- Guardar y recargar el chat.
- Selector de modelos, Ajustes, tema claro/oscuro y vista de móvil.
- El flag de modo voz llega al modelo.
- Servidor Whisper y TTS: el audio se envía bien y la API key no sale.
- Protecciones: otras webs bloqueadas, rutas maliciosas bloqueadas, URLs mal formadas sin romper el servidor, imágenes remotas y HTML peligroso anulados.
- La lógica de voz: división en frases, salto de código y "sí/no".

**No probado todavía (conviene que lo pruebes tú)**
- Hablar con el **micrófono real**: el navegador de pruebas lo bloquea.
- Que Shiro **escriba, haga clic o abra apps de verdad**: no quise actuar sobre tu pantalla mientras la usabas.
- Que `npm run app` abra la ventana.
- Un **modelo real** (no había Ollama ni LM Studio encendidos).

**Problemas encontrados y resueltos por el camino**
- **Windows Defender bloqueaba la captura de pantalla hecha con un script.** Se movió al código compilado en C#, y ahora el antivirus no la bloquea.
- **Telegram:** el bot responde a cualquiera, así que el control del PC se habría expuesto a desconocidos. Ahora solo se ofrece donde se puede pedir permiso.
- **Shiro podía cerrar su propia ventana** con "cierra Edge". Ahora la reconoce por el título.
- **Imágenes remotas en respuestas del modelo:** podían usarse para filtrar datos. Ahora se muestran como enlace.
- **`npm run dev` fallaba desde PowerShell** con `/bin/bash: node: command not found`. El archivo `.npmrc` mandaba ejecutar los comandos en `bash`, que en PowerShell es el Ubuntu de WSL (sin Node). Se borró. `npm run check`, `npm test` y `npm run dev` funcionan desde PowerShell.

Todo lo creado solo para las pruebas se borró: la carpeta `data/`, las capturas de tu pantalla, el chat de prueba y la configuración temporal.

---

## 8. Limitaciones conocidas

- La voz "de navegador" necesita internet y Edge o Chrome (no funciona en Firefox). Para usarla sin internet hay que montar un servidor Whisper o Kokoro.
- En modo voz no se le puede interrumpir hablando, solo tocando el círculo. Así se evita que se escuche a sí mismo.
- Hacer clic en sitios concretos requiere un modelo con visión y solo funciona en la **pantalla principal**.
- Con modelos en la nube, las capturas de pantalla se envían a ese proveedor.
- El control completo del PC es solo para Windows.
- "Permitir siempre en este chat" se olvida al reiniciar Shiro.
- Los chats se titulan con el primer mensaje; no se genera un título con IA.

---

## 9. Siguientes pasos sugeridos

1. Encender un modelo (por ejemplo `ollama pull qwen3:8b`) y abrir Shiro con `npm run app`.
2. Probar: "¿cómo está mi PC?", "abre Spotify", "sube el volumen", "escribe hola en el Bloc de notas" (te pedirá permiso) y el modo voz.
3. Si todo va bien, guardar los cambios en git.

---

## 10. OpenCode Go (suscripción)

- **Cabecera de sesión:** OpenCode Go ahora exige la cabecera `x-opencode-session` (un id estable por conversación). Shiro la envía con OpenCode Zen y Go: un hash del id del chat (nunca el id real), o un id por ejecución en la terminal y en `npm run doctor`. Cambios en `transports.ts` (`opencodeSessionHeader()`), `client.ts`, `LLMClient.ts` (`ChatOptions.sessionId`), `Agent.ts` (`AgentOptions.sessionId`) y `server.ts`.
- **Nombre del modelo:** con OpenCode se puede escribir el nombre visible ("Kimi K3") y Shiro lo convierte en el id que entiende la API (`kimi-k3`). Función `resolveModelId()` en `catalog.ts`.
- **Problema de OpenCode (no de Shiro):** desde el cambio a la consola nueva (septiembre de 2026), la web de OpenCode no muestra la API key de la suscripción Go. Las claves de "Service Account" (`oc_s...`) cobran del saldo de pago por uso, no de Go. Está abierto en su GitHub: [#52227](https://github.com/anomalyco/opencode/issues/52227) y [#50885](https://github.com/anomalyco/opencode/issues/50885). Si tienes una clave Go antigua (`sk-...`), sigue funcionando.
- Pruebas nuevas: `llm.test.ts` (la cabecera) y `catalog.test.ts` (nombres de modelo). 53 pruebas en total, todas pasan.

---

## 11. Telegram

- **Nuevo en Ajustes → Conexiones:** pega el token de tu bot (de @BotFather → `/newbot`) y pulsa Conectar. Shiro recibe los mensajes con "sondeo largo" desde tu PC: no hay que abrir puertos. Si quedó conectado, se reconecta solo al abrir Shiro (`telegramEnabled`).
- **Privado por defecto:** cualquiera puede encontrar un bot, así que Shiro solo responde a los chats autorizados (`telegramChats`). Si otra persona le escribe, recibe un aviso y aparece como solicitud en Ajustes con un botón **Autorizar**. No se llama al modelo para desconocidos: no gastan tu cuota ni ven tu memoria.
- Como en WhatsApp, desde Telegram no hay control del PC ni acciones que necesiten permiso. Solo chats privados (no grupos). Entiende texto y fotos. Las respuestas largas se parten en varios mensajes, y mientras piensa se ve "escribiendo…".
- El token nunca se envía al navegador ni aparece en los logs.
- Archivos: `src/telegram.ts` (nuevo), `src/telegram.test.ts` (nuevo), `config.ts` (`telegramToken`, `telegramEnabled`, `telegramChats`), `server.ts` (`/api/telegram/status|start|stop|allow|revoke` y arranque automático), `index.html` y `app.js` (sección en Conexiones).
- El antiguo `ChannelManager.ts` (herramienta `channel_create`) sigue sin funcionar para Telegram: genera un archivo que nunca se ejecuta. Usa Ajustes → Conexiones.

---

## 11. Habilidades, conectores MCP y comandos nuevos

### Habilidades (Ajustes → Habilidades)

Como en LM Studio: instrucciones especializadas guardadas en carpetas con un `SKILL.md` (el formato de Claude Code, Codex, OpenCode…).

- **Habilidades de Shiro:** botón "Agregar habilidad" para crear una (nombre, cuándo usarla e instrucciones), importar un `SKILL.md`, abrir la carpeta (`data/workspace/skills`) o añadir otra carpeta. Cada una se puede ver, editar, apagar o eliminar.
- **Usar habilidades de otras aplicaciones:** Shiro las encuentra y las usa solo, sin activar nada: Claude Code (`~/.claude/skills`), otros agentes (`~/.agents/skills`), Codex, GitHub Copilot, OpenCode y LM Studio. Cada aplicación tiene su interruptor para apagarla, y tocando la fila se ven sus habilidades y se pueden apagar una a una. Las que vienen incluidas con la propia aplicación (las copias de claude.ai en `~/.claude/skills/synced` y las de sistema de Codex en `~/.codex/skills/.system`) se ven pero empiezan apagadas, porque suelen pedir herramientas que Shiro no tiene (el navegador de Claude, el generador de imágenes de Codex…). Si la misma habilidad está copiada dos veces en una carpeta, sale una sola vez.
- **Cómo las usa el modelo:** solo recibe la lista (nombre y descripción, las más relacionadas primero). Si una encaja, la carga con la herramienta nueva `use_skill`. Si una destaca claramente para tu mensaje, Shiro se la recomienda (los modelos pequeños casi nunca las cargan solos).
- **Forzar una:** escribe `/nombre lo que quieras` en el chat.

### Conectores MCP (Ajustes → Conectores MCP)

Hasta ahora Shiro solo era servidor MCP (para OpenCode). Ahora también se **conecta** a servidores MCP y usa sus herramientas.

- **Agregar servidor:** un programa de tu PC (por ejemplo `npx -y @playwright/mcp@latest`) o una URL remota, con variables de entorno o cabeceras para las claves. Hay ejemplos listos: navegador (Playwright), archivos de una carpeta y documentación (Context7).
- **Importar** los que ya tengas en LM Studio, Claude Desktop, Claude Code, Cursor, VS Code u OpenCode (el propio Shiro no se importa, para que no se arranque a sí mismo).
- **Editar mcp.json:** el mismo formato que LM Studio o Claude Desktop, para pegar la configuración de cualquier servidor. Se guarda en `data/mcp.json`.
- Cada servidor muestra su estado (conectado, conectando, error, apagado), sus herramientas, la versión y el registro. Se puede reiniciar, editar, apagar o eliminar, y apagar herramientas sueltas.
- **Permisos:** sus herramientas piden permiso siempre (con "Permitir siempre en este chat"), salvo las que marques "Sin preguntar". Solo se ofrecen en la ventana y en la terminal, nunca en WhatsApp o Telegram.
- Las claves de las variables de entorno y cabeceras no se envían al navegador: se ven como `••••••` y se conservan al editar.
- Abajo está la configuración para usar **Shiro como servidor MCP** en OpenCode, Claude Code o Cursor, con la ruta ya puesta y botón Copiar.

### Comandos

- **Borrados:** `npm run config`, `npm run onboard` y `npm run personalize` (el asistente de la terminal con la pregunta del "modo autónomo"). Todo eso ya estaba en Ajustes. Si alguien los escribe, Shiro le dice que use Ajustes. También se quitó la dependencia `@inquirer/prompts`, que solo usaban ellos.
- **`npm start`** ahora abre Shiro en su ventana (igual que `npm run app`). **`npm run ayuda`** muestra la lista de comandos.
- **Comandos del chat, iguales en la web y en la terminal:** `/ayuda`, `/nuevo`, `/estado`, `/modelo [nombre]`, `/habilidades`, `/mcp`, `/herramientas on|off`, `/explica off|breve|on` y `/<habilidad> texto`. Se aceptan también en inglés (`/help`, `/status`…).
- **Menú al escribir `/`** en el cuadro de texto, con los comandos y las habilidades. Se elige con las flechas y Enter o Tab.
- **Se quitaron** `/compact`, `/reset` y `/new` del servidor, que respondían "hecho" sin hacer nada. Ahora `/nuevo` abre de verdad un chat vacío.

### Otros arreglos

- Los avisos ("Guardado", errores) quedaban tapados por la ventana de Ajustes. Ahora se ven.
- Los menús desplegables funcionan dentro de Ajustes.

### Archivos

| Archivo | Qué es |
|---|---|
| `src/core/skills/SkillLoader.ts` | Reescrito: busca habilidades (hasta 3 niveles), lee el encabezado de los `SKILL.md`, arma la lista para el modelo, `use_skill` y crear/editar/importar/borrar las de Shiro |
| `src/core/mcp/mcpConfig.ts` | `data/mcp.json`: validación, guardar, partir el comando en una línea, importar de otras aplicaciones |
| `src/core/mcp/McpManager.ts` | Conexiones MCP (programa local, HTTP o SSE), lista de herramientas, ejecutarlas, estado y registro |
| `src/core/tools/modules/skills.ts` | La herramienta `use_skill` |
| `src/extensionsApi.ts` | API de las pestañas Habilidades y Conectores MCP (`/api/skills*`, `/api/mcp*`, `/api/commands`) |
| `src/commands.ts` | Reescrito: comandos del chat compartidos por web y terminal |
| `public/js/extensions.js` | Pestañas Habilidades y Conectores MCP |
| `public/js/commands.js` | Menú de comandos al escribir `/` |
| `src/index.ts`, `package.json` | Comandos de npm nuevos y borrados |
| `src/tui.ts`, `src/onboard.ts`, `src/personalize.ts`, `src/modelSetup.ts` | Borrados |
| `Agent.ts`, `ContextBuilder.ts`, `ToolRegistry.ts`, `approval.ts`, `schemas.ts`, `tools.ts`, `roleManager.ts`, `config.ts`, `server.ts`, `chat-cli.ts` | Conexión de todo lo anterior |
| Pruebas nuevas | `skills.test.ts`, `mcp.test.ts` (incluye una conexión MCP real con un servidor de prueba, `echoServer.fixture.mjs`) y `commands.test.ts` |

### Cómo se probó

- `npm run check` sin errores y `npm test` con **73 pruebas, todas pasan**.
- En la ventana (en otro puerto, sin tocar tu Shiro abierto): activar Claude Code y ver sus habilidades, ver el contenido de una, crear una habilidad, el menú de `/`, añadir un servidor MCP, que se conecte con sus herramientas, editarlo sin perder la clave, "Sin preguntar", apagar una herramienta, el editor de `mcp.json` con un error a propósito, y la vista de móvil.
- **Con tu modelo real (qwen3:8b en Ollama):**
  - Usó una herramienta MCP, pidió permiso con lo que iba a hacer y respondió bien. Al rechazar el permiso, no la ejecutó.
  - Con `/resumir-correos …` siguió la habilidad.
  - Sin `/`, con "Resume este correo…", eligió la habilidad solo (antes de la recomendación no lo hacía).
- Todo lo creado para las pruebas se borró y tu `data/config.json` quedó exactamente como estaba.

### Después: habilidades que se detectan solas y Shiro que se actualiza solo

- **Por qué salía vacía la pestaña Habilidades:** el Shiro que tenías abierto (`npm run dev`) había arrancado antes de estos cambios, así que no conocía la pestaña nueva. Ahora, si pasa eso, la pestaña lo dice ("Reinicia Shiro para ver esto") en vez de quedarse en blanco.
- **Las habilidades de Claude Code, Codex y los demás se usan solas.** Antes había que encender cada aplicación; ahora vienen encendidas y solo apagas lo que no quieras. Cada fila dice cuántas están en uso ("13 habilidades" o "13 de 25 en uso").
- **`npm run dev` se reinicia solo** cuando cambia el código (usa `tsx watch`), así siempre tienes la última versión.
- **`npm start` (y el icono del escritorio) cierran un Shiro viejo**: si ya había uno abierto y el código cambió desde que arrancó, lo cierran y abren el nuevo. Para eso el servidor guarda una clave en `data/cache/server-<puerto>.json` que solo sirve desde este PC. Si el Shiro abierto es tan viejo que no tiene esa clave (como el que tenías ahora), `npm start` te avisa de que lo cierres tú una vez.
- Leer todas las carpetas de habilidades en cada mensaje sería lento: se recuerda lo leído durante 3 segundos.
- Archivos: `SkillLoader.ts`, `config.ts` (`disabledSkillSources` y `enabledSkills` en vez de `skillSources`), `extensionsApi.ts`, `server.ts`, `app.ts`, `package.json`, `public/js/extensions.js`, `public/js/api.js`, `public/index.html`, `public/css/app.css`, y una prueba nueva en `skills.test.ts` (con una carpeta de usuario de mentira: no toca las tuyas).

## 12. Paneles "Navegador" y "Terminal" (como en Claude)

Arriba a la derecha del chat hay dos botones nuevos: 🌐 **Navegador** y `>_` **Terminal**. Abren paneles a la derecha del chat. Si abres los dos, quedan uno encima del otro. El ancho se cambia arrastrando el borde izquierdo.

- **Navegador de Shiro.** Es un Chrome sin ventana, con su propio perfil (`data/browser-profile`). Por eso no toca tu Chrome ni tus pestañas. Lo ves en vivo en el panel y **tú también lo puedes usar**: escribes una dirección, haces clic, escribes y te desplazas con la rueda.
  - Shiro lo maneja con la herramienta nueva `browser`: abre webs o busca, lee la página (texto y botones numerados), hace clic, escribe y vuelve atrás.
  - Cuando Shiro lo usa, el panel se abre solo y muestra "Shiro lo está usando…".
  - **Permisos:** leer y moverse por las webs no pide permiso. **Hacer clic o escribir sí**, porque podría enviar un formulario o comprar algo. Puedes darle "Permitir siempre en este chat".
  - Las descargas están desactivadas y no abre archivos del PC (`file:`), ni la propia web de Shiro.
  - Si lo dejas sin usar 30 minutos con el panel cerrado, se cierra solo para liberar memoria. El botón ⏻ del panel lo cierra en el momento.
- **Terminal.** Es una PowerShell de verdad que sigue abierta entre comandos (se acuerda de la carpeta y de las variables). Escribes abajo y pulsas Enter. ↑/↓ recorre el historial, Ctrl+C detiene lo que corre y Ctrl+L limpia.
  - Shiro la usa con la herramienta `terminal`: **lee lo que hay** (tus comandos, su salida y los errores) y puede **ejecutar comandos a tu vista**. Estos piden permiso, igual que antes. Los comandos que lanza Shiro llevan la etiqueta "Shiro".
  - Tus claves de Shiro (API keys, tokens) no se pasan a la terminal, porque el modelo puede leerla.
- **Esfera del modo voz:** ahora es un holograma dorado animado. Late con tu voz y la de Shiro, gira más rápido cuando piensa y se pone rojiza cuando pide permiso.

Cosas a saber:
- Usa **Google Chrome** si está instalado (Edge sin ventana da problemas en algunos PC, como este). Si no hay Chrome, Shiro prueba con el Chrome que descargó WhatsApp y después con Edge.
- Algunas webs detectan navegadores automáticos y pueden pedir un captcha. Eso lo resuelves tú en el panel.
- Archivos nuevos: `src/core/browser/` (`browser.ts`, `pageModel.ts`, `findBrowser.ts`), `src/core/terminal/terminal.ts`, `src/core/tools/modules/workbench.ts`, `src/panelsApi.ts`, `public/js/panels.js`, `public/js/orb.js`, pruebas `pageModel.test.ts` y `terminal.test.ts`. Dependencia directa nueva: `puppeteer-core` (ya estaba instalada a través de WhatsApp).
- Cómo se probó: con qwen3:8b, "Abre en tu navegador es.wikipedia.org/wiki/Gato y dime de qué trata" → usó el navegador y respondió bien. "Mira mi terminal: ¿qué error sale?" → leyó el error de `npm run noexiste`. Para hacer clic en un enlace pidió permiso ("Hacer clic en enlace "Learn more" en example.com"). Buscar el clima desde el chat abrió el panel solo y mostró la búsqueda en vivo.

## 13. Bienvenida y "¿Dónde guardo tus cosas?"

- **Bienvenida del primer arranque** (`public/js/setup.js`): si no hay nombre de usuario ni `setupDone`, la web
  pregunta en 4 pasos quién eres (lo mismo que Ajustes → Personalización), cómo se llama el asistente, dónde
  guardar las cosas y qué modelo usar (con "Probar conexión"; se puede saltar). Se repite en Ajustes → General.
- **Dónde se guardan chats, recuerdos y recordatorios** (Ajustes → Datos y la bienvenida):
  - *En este equipo* (como antes).
  - *En Obsidian*: todo va a la carpeta `Shiro` de la bóveda: una nota por chat (`Chats/`), por recuerdo
    (`Recuerdos/`), `Recordatorios.md`, y la memoria (SOUL.md, MEMORY.md, memory/). `memory_search` busca
    también en todas las notas de la bóveda. Detecta las bóvedas de la app de Obsidian.
  - *En Supabase*: tablas `shiro_*` (Shiro muestra el SQL para pegar en el SQL Editor). Pide la clave secreta
    (rechaza la pública con un mensaje claro); la clave no se envía nunca al navegador.
  - Al cambiar, **"Llevar mis datos"** copia lo que ya había; si algo falla, se sigue usando el sitio anterior.
- **Arreglos que salieron al hacerlo**:
  - `memory_add` decía "Recuerdo guardado" pero no guardaba nada, y `memory_search` nunca encontraba nada.
    Ahora se guardan de verdad y se buscan por palabras (y por significado si Ollama da embeddings).
  - `sessions_list` / `sessions_history` siempre salían vacíos: ahora leen los chats reales.
  - Los recordatorios se guardaban en `src/data/` en vez de `data/` (en Docker Shiro se caía al arrancar).
- **Técnico**: `SHIRO_DATA_DIR` cambia la carpeta de datos (las pruebas usan una temporal: `src/storage/storage.test.ts`,
  13 pruebas, con Supabase simulado). Los recordatorios ahora son asíncronos.
- **Sin probar contra un Supabase real**: las pruebas usan una API simulada. Pruébalo con tu proyecto antes de fiarte.
