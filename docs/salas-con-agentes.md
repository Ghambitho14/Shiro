# Salas con varios agentes: qué está hecho y qué falta

- **Fecha:** 26-10-2026
- **Rama:** `claude/upbeat-faraday-rz1fcm`
- **Estado de las pruebas:** `npm run check` pasa y `npm test` da **166/166**.

Una «sala» es un chat donde hablan varios agentes (por ejemplo Viernes y Lunes), cada uno
con su nombre, color, voz y modelo. Uno es el **principal** (★): responde cuando no nombras a nadie.

Antes de tocar nada, lee `AGENTS.md` (mapa del código y reglas).

---

## 1. Hecho

### Lo que ya existía antes de esta etapa

| Parte | Archivos | ¿Probado? |
|---|---|---|
| Lista de agentes (nombre, alias, modelo, voz, color, herramientas…) y reglas de nombres | `src/core/agents/registry.ts`, `src/core/agents/text.ts` | Pruebas unitarias (`agents.test.ts`) |
| Guardar la sala de cada chat (`data/rooms/<id>.json`) | `src/core/rooms/roomStore.ts` | Pruebas unitarias (`rooms.test.ts`) |
| Entender órdenes («activa Viernes», «agrega a Lunes», «puedes irte»…) | `src/core/rooms/roomIntent.ts` | Pruebas unitarias |
| Aplicar la orden a la sala (quién entra, quién sale, quién es principal) | `src/core/rooms/roomLogic.ts` | Pruebas unitarias |
| Historial que ve cada agente (máx. 30 mensajes o la mitad del contexto, y cuántos se dejaron fuera) | `src/core/rooms/roomHistory.ts` (`buildRoomHistory`), `src/core/rooms/roomTurn.ts` | Pruebas unitarias |
| Turno de sala: `planRoomTurn` (orden o quién responde) y `prepareAgentTurn` (modelo, forma de ser, herramientas, historial) | `src/core/rooms/roomTurn.ts` | Pruebas unitarias (nuevas, ver abajo) |
| Un modelo por agente | `src/core/llm/providers.ts` (`ModelRef`), `src/core/llm/client.ts` (`createLLMClientFor`), `src/core/llm/getLLM.ts` (`getLLMFor`) | Pruebas unitarias |
| Solo un modelo local cargado a la vez (descarga los otros en Ollama/LM Studio) | `src/core/llm/modelGate.ts` (`acquireModel`) | Pruebas unitarias + servidor HTTP falso |
| Forma de ser del agente y bloque «## Sala» en el system prompt | `src/core/agent/ContextBuilder.ts`, `src/core/agent/Agent.ts` | Pruebas unitarias |
| API de agentes y salas (`/api/agents*`, `/api/rooms*`) | `src/agentsApi.ts` | Sin probar |
| Servidor: órdenes de sala, eventos SSE `room` y `agent`, un turno a la vez, borrar la sala al borrar el chat | `src/chatApi.ts` | Sin probar |
| Voz de cada agente (`voice` en `/api/voice/speak`) | `src/voiceApi.ts`, `public/js/voice.js` | Sin probar |
| Comando `/agentes` | `src/commands.ts` | Sin probar en uso real |
| Web: Ajustes → Agentes; barra de la sala con nombre, color y participantes | `public/js/agents.js`, `public/js/rooms.js` | Sin probar |
| Ajustes de la palabra de activación (`wakeWordEnabled`, `wakeWord`, `wakeSensitivity`, `wakeLanguage`) | `src/config/config.ts` | Solo existen; **todavía no hacen nada** |

### Lo que hizo el agente anterior (4 commits)

| Commit | Parte | Archivos | ¿Probado? |
|---|---|---|---|
| `2dce51d` | Arreglo de 3 pruebas que fallaban en el PC del usuario (ver nota abajo) | `src/core/tools/approval.test.ts`, `src/core/tools/tools.test.ts` | Sí, pasan |
| `1ad843f` | Salas en la terminal (Fase C) | `src/chat-cli.ts` | Con un modelo falso compatible con OpenAI. **El aviso de permiso con el nombre del agente NO se probó** |
| `a8c1c9b` | 12 pruebas nuevas | `src/core/agent/ContextBuilder.test.ts`, `src/chat/ChatStore.test.ts`, `src/core/rooms/roomTurn.test.ts`, `src/core/llm/modelGateUnload.test.ts` | Sí, pasan |
| `9c511be` | Mapa y reglas de agentes y salas en `AGENTS.md` | `AGENTS.md` | No aplica |

**Por qué fallaban las 3 pruebas (`2dce51d`):** dos en `approval.test.ts` y «getWorkspaceDir devuelve
ruta bajo data» en `tools.test.ts`. Leían el `data/config.json` real del usuario:
`approvalMode: "allow"` aprueba sin preguntar y `storage: "obsidian"` hace que el workspace sea la bóveda.
Ahora usan una carpeta temporal (`SHIRO_DATA_DIR`) y fijan la config (`approvalMode: "ask"`,
`execAllowlist: []`, `storage: "local"`). El código de la app no se tocó.

**La sala en la terminal (`1ad843f`):**

- La sala vive solo en memoria (no se guarda en `data/rooms`).
- Antes de cada respuesta llama a `planRoomTurn()`; si responde un agente, `prepareAgentTurn()`.
- El indicador muestra quién habla: `Viernes ›`.
- El aviso de permiso dice el nombre del agente: «⚠ Viernes quiere: …».
- Comando nuevo `/sala` (participantes y principal). `/nuevo` borra también la sala.

**Las 12 pruebas nuevas (`a8c1c9b`):**

- `ContextBuilder`: forma de ser «añadir» y «reemplazar», y el bloque «## Sala».
- `ChatStore`: `agent` y `agentName` solo en respuestas del asistente con id válido.
- `roomTurn`: 3 de `planRoomTurn` y 2 de `prepareAgentTurn`.
- `modelGate`: descargas de Ollama y LM Studio (y LM Studio viejo) contra un servidor HTTP falso.

> **Importante:** nada de esto se ha probado con LM Studio u Ollama reales, ni en Windows,
> ni en la web de verdad, ni con voz.

---

## 2. Falta (en este orden)

### 2.1 Probar la sala en la web

Necesita **Windows + LM Studio**.

**Preparar un Shiro de prueba (sin tocar el del usuario):**

1. Crea una carpeta de datos aparte y apunta `SHIRO_DATA_DIR` a ella.
2. Copia ahí `config.json` y `state.json` del `data/` del usuario, y su carpeta `Shiro/` de la bóveda
   como `workspace/` (ahí están `Sobre mí.md` y `Agentes/`).
3. En esa copia pon `storage: "local"`, para no escribir en la bóveda de Obsidian del usuario.
4. Usa el **puerto 1417** (el servidor lee la variable `PORT`).
5. Añade una entrada temporal en `.claude/launch.json` (ya hay una, «shiro-prueba», en el 1407).
   **Quítala al terminar.**

**Lista de comprobación:**

| # | Qué hacer | Qué debe pasar |
|---|---|---|
| 1 | Crear **Viernes** (modelo de Ajustes) y **Lunes** (LM Studio, otro modelo, p. ej. `qwen3.8-9b-distill@q5_k_m`) | Se guardan sin errores |
| 2 | Escribir «Aku, activa Viernes» | Saludo con nombre y color de Viernes; barra con «Viernes ★» |
| 3 | «Viernes, agrega a Lunes» | Aparece la ficha de Lunes |
| 4 | «¿Qué opinas, Lunes?» | Responde Lunes con su modelo. `curl http://localhost:1234/api/v1/models` muestra en `loaded_instances` solo el modelo de Lunes |
| 5 | Un mensaje sin nombres | Responde Viernes y solo su modelo queda cargado |
| 6 | «Recuérdame el lunes comprar pan» | Responde Viernes, **no** Lunes |
| 7 | «Lunes, ahora te encargas tú» | La ★ pasa a Lunes |
| 8 | «Gracias Lunes, puedes irte» | Lunes sale; Viernes vuelve a ser principal |
| 9 | Recargar la página | Mismos nombres y misma barra |
| 10 | Borrar el chat | Desaparece `data/rooms/<id>.json` |
| 11 | Botones de la barra: «Hacer principal», «Quitar de la sala», «Sumar agente», y «Hablar con un agente» en un chat normal | Cada uno hace lo que dice |
| 12 | Ajustes → Agentes: «Abrir sala» y «Probar modelo» | Abre la sala / prueba el modelo |
| 13 | Modo voz en una sala | Título «Modo voz · Viernes»; cada agente con su voz. Un agente con `mode: "voice"` abre el modo voz al activarlo |
| 14 | «Aku, activa Viernes y dime la hora» | Viernes responde directamente, sin saludo |
| 15 | Revisar | Consola del navegador y registros del servidor sin errores |

> **Cuidado:** al cambiar de modelo, Shiro también descarga en LM Studio el modelo que usa el
> Shiro del usuario. Al terminar, deja cargado `qwen/qwen3.5-9b`.

### 2.2 Probar la terminal con un modelo real

- `npm run tui` (o el subcomando `tui`) con LM Studio u Ollama de verdad.
- Repetir las órdenes de la lista (activar, agregar, nombrar, despedir, `/sala`, `/nuevo`).
- Probar **el aviso de permiso con el nombre del agente** (por ejemplo, pedir algo que use `exec`):
  debe decir «⚠ Viernes quiere: …». Esto aún no se ha probado nunca.

### 2.3 Palabra de activación «Aku» (Fase D, sin empezar)

Depende del informe de la sesión de pruebas: medir si el reconocedor de voz de Windows
(WinRT, `es-MX`) funciona **sin internet**, cuánta CPU/RAM usa y cuántas activaciones falsas da.

**Si WinRT funciona:**

| Pieza | Qué hace |
|---|---|
| `src/core/wake/wakeGrammar.ts` | Puro y con pruebas: frases a partir de la palabra y los nombres de los agentes; umbral según la sensibilidad |
| `src/core/wake/wakeHelperSource.ts` | C# compilado una sola vez a `data/cache/wake-<hash>.dll` (igual que `src/core/pc/nativeHelper.ts`) |
| `src/core/wake/wakeListener.ts` | PowerShell de larga duración. Datos por `$env:SHIRO_A_*`, **nunca dentro del script**. Estados: apagado / escuchando / en pausa / no disponible / error (con motivo en español). Se reinicia si se cae. 2 s entre detecciones |
| `src/appEvents.ts` (nuevo) | `GET /api/events` por SSE. Toda la API ya pide la contraseña (`isSensitivePath()` de `src/server.ts`); la ruta va en su propio `handleXApi` |

**Al detectar la palabra:**

1. Pausar la escucha.
2. Si se nombró un agente, crear la sala con `openRoomChat()` (ya existe en `src/agentsApi.ts`).
3. Avisar a la web por `/api/events`.
4. Abrir la ventana con `openAppWindow()` (ya existe en `src/app.ts`) en `#/voz/<sessionId>`.
   Registrarla con un `setWindowOpener` nuevo para evitar un import circular.

**En la web:**

- `route()` de `public/js/sidebar.js` debe entender `#/voz/<id>` (hoy no lo hace).
- Saludar con la voz del agente: `voice.open({ greet, agent })` (ya existe en `voiceMode.js`).
- Pausar la escucha mientras el modo voz está abierto y reanudarla al cerrarlo
  (reanudar sola a los 2 minutos).
- Ajustes → Voz: interruptor «Escucha siempre la palabra «Aku» sin conexión; nada sale del equipo
  hasta que la dices», palabra, sensibilidad, estado, última detección, y una nota: después de la
  palabra, el reconocimiento del navegador sí va por internet.

**Si WinRT no funciona (plan B):** vosk-browser (WASM) en un Edge sin ventana con `puppeteer-core`
y un modelo pequeño en español con sha256 fijo. **Preguntar al usuario antes de descargar nada.**

### 2.4 ~~Pruebas que escribían en el `data/` real~~ (arreglado)

`npm test` carga `src/test-setup.ts`, que da a cada archivo de prueba una carpeta temporal si no eligió
la suya, y el registro de decisiones (`DecisionLogger.ts`) ya no existe. Ninguna prueba toca el `data/` real.

---

## 3. Para después (fuera de esta etapa)

- Un clasificador barato que elija el modelo según el tipo de pregunta.
- Resumen del historial en salas largas (hoy: últimos 30 mensajes o la mitad del contexto, con una
  nota de cuántos se dejaron fuera).
- Claves de API por proveedor. Hoy un agente con otro proveedor usa la variable de entorno de ese
  proveedor (p. ej. `OPENROUTER_API_KEY`).
- Salas en Telegram y WhatsApp.
- El asistente de siempre como un participante más.
- Color de la esfera del modo voz según el agente.
- Renombrar el proyecto de Shiro a Aku (el asistente ya se llama Aku en `state.json`; el código
  nuevo evita «shiro» en los nombres).

---

## 4. Decisiones ya tomadas (no volver a preguntar)

- Primera versión: **web y terminal**.
- El principal puede cambiar a mitad de conversación (con una frase o con el botón).
- Activación tipo Alexa con «Aku»: **sin modelo y sin internet**.
- Las órdenes de sala se contestan con **texto fijo**, sin modelo.
- Si se nombran varios agentes, **gana el primero**.
- «el lunes», «para el viernes», etc. **no** son menciones; `@nombre` **siempre** lo es.
- No puede haber dos agentes con el mismo nombre o alias, ni uno que se llame como el asistente,
  la palabra de activación o una palabra de las órdenes.
