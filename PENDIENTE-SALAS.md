# Salas con varios agentes: lo que falta

Estado al 26-10-2026, en la rama `mejoras-agente`. **Todavía no hay nada guardado en git.**

El plan completo está en `C:\Users\jhon_\.claude\plans\pasted-content-id-1036-shiro-dise-o-tidy-eagle.md`.

---

## 1. Lo que ya está hecho

| Parte | Archivos | Probado |
|---|---|---|
| Registro de agentes (`data/agents.json`): nombre, alias, modelo, forma de ser, herramientas, voz, saludo y color; rechaza los nombres que se confunden | `src/core/agents/registry.ts`, `text.ts` | Pruebas ✔ y en el navegador |
| Salas guardadas aparte (`data/rooms/<chat>.json`) | `src/core/rooms/roomStore.ts` | Pruebas ✔ |
| Detector de órdenes y menciones (sin modelo) | `src/core/rooms/roomIntent.ts` | Pruebas ✔ |
| Qué hace cada orden y qué responde | `src/core/rooms/roomLogic.ts` | Pruebas ✔ |
| Historial compartido marcado con «[Nombre]: …» | `src/core/rooms/roomHistory.ts` | Pruebas ✔ |
| Preparar el turno de un agente (modelo, forma de ser, herramientas) | `src/core/rooms/roomTurn.ts` | Sin probar de punta a punta |
| Un modelo distinto por agente | `providers.ts` (`ModelRef`), `client.ts` (`createLLMClientFor`), `getLLM.ts` (`getLLMFor`) | Pruebas ✔ |
| Un solo modelo cargado a la vez: descarga el anterior en Ollama, LM Studio y GGUF | `src/core/llm/modelGate.ts` | Pruebas ✔ con descargas falsas. **Con LM Studio real, sin probar** |
| Forma de ser y bloque «## Sala» en las instrucciones | `src/core/agent/ContextBuilder.ts`, `Agent.ts` | Sin prueba propia |
| API `/api/agents*` y `/api/rooms*` | `src/agentsApi.ts` | Crear agentes ✔ en el navegador |
| Chat del servidor: órdenes de sala, eventos SSE `room` y `agent`, un turno a la vez por sala, borrar la sala al borrar el chat | `src/server.ts` | **Sin probar** |
| Voz del servidor por agente (`voice` en `/api/voice/speak`) | `src/server.ts`, `public/js/voice.js` | Sin probar |
| Comando `/agentes` | `src/commands.ts` | Sin probar |
| Web: pestaña Ajustes → Agentes | `public/js/agents.js`, `public/index.html` | Formulario ✔ |
| Web: nombre y color en cada respuesta, barra de participantes, voz por agente en el modo voz | `public/js/app.js`, `api.js`, `css/app.css` | **Sin probar** |
| Ajustes de la palabra de activación (`wakeWordEnabled`, `wakeWord`, `wakeSensitivity`, `wakeLanguage`) | `src/config/config.ts` | Solo están en la config: todavía no hacen nada |

---

## 2. Lo que falta

### 2.1 Probar la sala en la web (lo más urgente)

Usa un Shiro de prueba en el **puerto 1417** con una carpeta de datos aparte, para no tocar el del usuario (1406):
- Copia `data/config.json`, `state.json` y `user-profile.json` a una carpeta temporal.
- En la copia de `config.json` pon **`storage: "local"`**. El usuario usa Obsidian y la prueba no debe escribir en su bóveda.
- Añade una entrada en `.claude/launch.json` con `PORT=1417` y `SHIRO_DATA_DIR=<esa carpeta>`, y bórrala al terminar.

Comprobar, en orden:
1. Crear a Viernes (con el modelo de Ajustes) y a Lunes (LM Studio, otro modelo, p. ej. `qwen3.8-9b-distill@q5_k_m`).
2. Escribir «Aku, activa Viernes». Debe salir el saludo con el nombre y el color de Viernes, y la barra de participantes con Viernes ★.
3. «Viernes, agrega a Lunes». Aparece el chip de Lunes.
4. «¿Qué opinas, Lunes?». Responde Lunes con su modelo.
   - `curl http://localhost:1234/api/v1/models` debe mostrar **solo** el modelo de Lunes cargado (`loaded_instances`).
5. Un mensaje sin nombres: responde Viernes y vuelve a quedar cargado solo su modelo.
6. «Recuérdame el lunes comprar pan». Debe responder Viernes, no Lunes.
7. «Lunes, ahora te encargas tú». La ★ pasa a Lunes.
8. «Gracias Lunes, puedes irte». Lunes sale y Viernes vuelve a ser el principal.
9. Recargar la página: los nombres y la barra siguen igual.
10. Borrar el chat: tiene que desaparecer `data/rooms/<id>.json`.
11. Botones de la barra: «Hacer principal», «Quitar de la sala», «+ Sumar agente» y «Hablar con un agente» en un chat normal.
12. Ajustes → Agentes → «Abrir sala» y «Probar modelo».
13. Modo voz dentro de una sala: el título cambia a «Modo voz · Viernes» y cada agente habla con su voz.
    - Con un agente que tenga `mode: "voice"`, el modo voz se abre solo al activarlo.
14. «Aku, activa Viernes y dime la hora»: responde Viernes directamente, sin saludo.
15. Mirar la consola del navegador y los registros del servidor por si hay errores.

Si algo falla, arréglalo antes de seguir.

**Ojo:** al cambiar de modelo, el que usa el Shiro del usuario en LM Studio también se descarga. LM Studio lo vuelve a cargar solo cuando hace falta, pero tarda unos segundos. Al terminar, deja cargado `qwen/qwen3.5-9b` como estaba.

### 2.2 Las 3 pruebas que fallan

`npm test` da 143 de 146. Fallan:
- `src/core/tools/approval.test.ts`: «sin approver (ej. WhatsApp) la acción se bloquea» y «con approver se respeta la respuesta del usuario».
- La prueba de `getWorkspaceDir`: «getWorkspaceDir devuelve ruta bajo data».

Al principio de la sesión pasaban las 146, y esta función no tocó esos archivos. Lo más probable es que estas pruebas lean el `data/config.json` real (`approvalMode`, `storage: "obsidian"`) y que el usuario cambiara algún ajuste. Hay que confirmarlo:
- Correr esas pruebas con `SHIRO_DATA_DIR` apuntando a una carpeta temporal.
- Si pasan así, hacer que esas pruebas usen siempre una carpeta temporal, como `modelSettings.test.ts`.

### 2.3 La terminal (`src/chat-cli.ts`): Fase C, sin empezar

- Guardar la sala en memoria (`RoomState | null`, sin archivo) y pasar el historial a `ChatMessage[]` con `agent` y `agentName`.
- Antes de `runAgent`:
  - Llamar a `planRoomTurn()` (en `roomTurn.ts`).
  - Si hay respuesta fija, mostrarla como `Viernes › …`.
  - Si hay `responder`, usar `prepareAgentTurn()` y pasarle a `runAgent` lo que devuelve: `llm`, `agentName`, `persona`, `room`, `conversation`, `allowedTools` y `mcp`.
- Mostrar quién responde en el indicador de la terminal (`Viernes ›`). El aviso de permiso también debe decir el nombre del agente.
- Comando propio de la terminal, `/sala`: muestra los participantes y el principal. Añadirlo a la ayuda de la terminal.
- `/nuevo` también borra la sala.
- La terminal no tiene voz ni palabra de activación.

### 2.4 Palabra de activación «Aku»: Fase D, sin empezar

Depende de la sesión [Prueba: palabra 'Aku' con voz de Windows](#local_f45c3560-2b54-43c1-ad41-2de2e0c5a4ae). Está midiendo si el reconocedor de voz de Windows (WinRT, es-MX) sirve sin conexión, cuánto CPU y memoria usa y si se activa sin querer. Lee su informe antes de empezar.

- **Si WinRT sirve:**
  1. `src/core/wake/wakeGrammar.ts` (puro, con pruebas): arma las frases a partir de la palabra y de los nombres ("aku", "oye aku", "aku activa viernes"…) y lee cada resultado con un umbral según la sensibilidad.
  2. `src/core/wake/wakeHelperSource.ts`: el C# de la prueba, compilado una sola vez a `data/cache/wake-<hash>.dll`, como `src/core/pc/nativeHelper.ts`.
  3. `src/core/wake/wakeListener.ts`:
     - Un proceso de PowerShell que queda abierto.
     - Los datos le llegan por `$env:SHIRO_A_*`, nunca escritos dentro del script.
     - Sus estados: apagado, escuchando, pausado, no disponible o error, con el motivo en español.
     - Si se cae, se reinicia tras una espera. Espera 2 s entre una detección y la siguiente.
  4. Avisos a la web: `GET /api/events` (SSE) en un `src/appEvents.ts` nuevo. Ya está en `isSensitivePath`, igual que `/api/wake*`.
  5. Al oír la palabra:
     - Se pausa la escucha.
     - Si se nombró un agente, se crea la sala con `openRoomChat()` (en `src/agentsApi.ts`).
     - Se avisa a la web.
     - Si la ventana está cerrada, se abre con `openAppWindow()` (en `src/app.ts`, registrada con un `setWindowOpener` para no crear un import circular) en `#/voz/<sessionId>`.
  6. Web:
     - `route()` en `app.js` entiende `#/voz/<id>`: abre ese chat en modo voz y dice el saludo con la voz del agente (`voice_.open({ greet, agent })` ya existe).
     - La web pausa la escucha al abrir el modo voz y la reanuda al cerrarlo. Por seguridad, se reanuda sola a los 2 min.
  7. Ajustes → Voz:
     - Un interruptor: «Escucha siempre la palabra «Aku» sin conexión; nada sale del equipo hasta que la dices».
     - El campo de la palabra, la sensibilidad, el estado y la última detección.
     - Un aviso de que, después de la palabra, el reconocimiento del navegador funciona por internet.
- **Si WinRT no sirve:** usar el plan B, vosk-browser (WASM) en un Edge sin ventana con `puppeteer-core`, más un modelo pequeño en español descargado con sha256 fijo. **Preguntar al usuario antes de descargar nada.**

### 2.5 Pruebas que faltan

- `ContextBuilder.test.ts`: forma de ser «añadir» y «reemplazar», y el bloque «## Sala».
- `ChatStore`: `agent` y `agentName` solo se guardan en las respuestas del asistente y con un id válido.
- `roomTurn.ts`: herramientas del agente (`none` = solo texto, una lista se cruza con lo permitido si no está en modo autónomo, `inherit` = las de siempre) y respuesta fija frente a turno con modelo.
- `unloadLmStudio` / `unloadOllama` contra un servidor falso.
- `wakeGrammar.test.ts` cuando exista.

### 2.6 Documentación

Añadir a `AGENTS.md`:
- **Mapa:** `src/core/agents/`, `src/core/rooms/`, `src/core/llm/modelGate.ts`, `src/agentsApi.ts`, `public/js/agents.js` y, cuando existan, los de `src/core/wake/`.
- **Regla:** las rutas nuevas de la API van en `isSensitivePath()` (`src/server.ts`).
- **Regla:** el modelo de un agente se obtiene con `getLLMFor(perfil)`, nunca con `getLLM()`.
- **Regla:** cada vuelta con un modelo local pasa por `acquireModel` (ya lo hace `client.ts`).

### 2.7 Guardar en git

Cuando todo lo anterior pase (`npm run check` y `npm test` en verde), hacer el commit. La rama `mejoras-agente` también tiene muchos cambios de antes: revisar `git status` para no mezclar cosas sin querer.

---

## 3. Para después (fuera de esta etapa)

- Un clasificador barato que elija el modelo según el tipo de pregunta.
- Un resumen del historial cuando la sala es muy larga. Hoy se mandan los últimos 30 mensajes o la mitad del contexto, y se avisa cuántos quedaron fuera.
- Claves de API por proveedor. Hoy un agente con otro proveedor usa la clave de la variable de entorno de ese proveedor (p. ej. `OPENROUTER_API_KEY`).
- Salas en Telegram y WhatsApp.
- Que el asistente de siempre pueda ser un participante más de la sala.
- El color de la esfera del modo voz según el agente.
- **Cambiar el nombre del proyecto de Shiro a Aku**, como tarea aparte. En `state.json` el asistente ya se llama Aku. El código nuevo no usa "shiro" en los nombres para facilitar el cambio.

---

## 4. Decisiones ya tomadas (no volver a preguntar)

- Primera versión en la **web y la terminal**.
- El principal se puede cambiar a mitad de la conversación, con una frase o con un botón.
- Activación **tipo Alexa**: escucha sin modelo y sin internet, con la palabra «Aku».
- Las órdenes de sala se contestan con un texto fijo, sin llamar a ningún modelo.
- Cuando se nombra a varios agentes, gana el primero que aparece. «el lunes», «para el viernes», etc. no cuentan como mención; `@nombre` siempre cuenta.
- No puede haber dos agentes con el mismo nombre o alias, ni uno que se llame como el asistente, como la palabra de activación o como una palabra de las órdenes.
