# Mejoras: autonomía, alma, memoria, cerebro, WhatsApp y web/config

Propuestas concretas por área, basadas en el código actual.

---

## 1. Autonomía (HealthManager, LoopDetector, políticas)

- **LoopDetector y `tool_call`:** Hoy los eventos `tool_call` del **Planner** llevan `payload.step` (texto del paso), no `payload.name`. El detector de “misma acción” usa `payload.name`; en flujos con planner todos quedan como `undefined` y no se detecta bien el loop.  
  **Mejora:** Al hacer `pushEvent("tool_call", ...)` en `Agent.ts` (bucle del planner), incluir también `name: "planner_step"` o un nombre derivado del paso para que LoopDetector pueda contar repeticiones; o en `LoopDetector` tratar `payload.step` cuando no exista `name`.

- **Recuperación tras safe_mode:** Al entrar en safe_mode se desactivan herramientas de escritura en sistema; no hay camino automático para salir (solo `setSafeMode(false)` por código).  
  **Mejora:** Opción de “recuperar” desde la web o TUI (botón “Restaurar modo normal” que llame a un endpoint o comando que invoque `setSafeMode(false)`), o política tipo “salir de safe_mode tras N minutos sin errores”.

- **Intervención visible en WhatsApp/web:** Cuando HealthManager interviene, la respuesta es `[Intervención] ...`. En WhatsApp puede ser poco claro.  
  **Mejora:** Mensaje más amigable (“Shiro detectó un problema al intentar esto: … ¿Puedes reformular?”) y, en web, mostrar un estado o badge “Modo seguro” cuando `status === "safe_mode"` (usando `/api/health` o un campo extra).

- **Políticas configurables:** `policies` (maxStepsPerRun, etc.) están fijas en código.  
  **Mejora:** Leer desde `config.json` o variables de entorno (con valores por defecto) para ajustar autonomía sin tocar código.

---

## 2. Alma (SOUL)

- **SOUL y perfil de usuario:** El contexto ya incluye “Sobre el usuario” (nombre, idioma, sobre ti); el SOUL no menciona explícitamente “usa la información del usuario si la tienes”.  
  **Mejora:** En `soul.ts`, si se pasa un flag o el config indica que hay perfil, añadir una línea tipo: “Usa la sección ‘Sobre el usuario’ (si existe) para personalizar el tono y las respuestas.”

- **Identidad estable:** El SOUL depende de `agentName` (siempre “Shiro” en la práctica) y de `config.abilities`. Está bien; se podría documentar en el repo que “Shiro” es la identidad por defecto y que `abilities` es el lugar para instrucciones extra sin tocar SOUL.

- **Idioma:** SOUL dice “Responde en el mismo idioma que el usuario”. Si en el perfil hay `language`, el ContextBuilder ya lo inyecta; el SOUL podría decir “Responde en el idioma preferido del usuario si lo conoces, si no en el suyo.” para alinearlo con la personalización.

---

## 3. Memoria

- **Resumen largo plazo:** `Summarizer` concatena observaciones y recorta a 2000 caracteres; `keyFacts` solo usa `decision.reason` (que a veces no se rellena).  
  **Mejora:** Incluir en el resumen también eventos `tool_call`/`error` resumidos (ej. “Leyó X”, “Error: archivo no encontrado”) y mejorar la extracción de keyFacts (por ejemplo desde observaciones que contengan “importante:” o “recordar:”).

- **openTasks:** El Summarizer tiene `// TODO: extraer openTasks de texto`.  
  **Mejora:** Regla simple (ej. líneas que empiecen por “pendiente:”, “TODO:”, “por hacer:”) o un pequeño prompt/parser para rellenar `openTasks` y que el agente pueda ver “tareas abiertas” en el contexto.

- **Memoria por canal:** WhatsApp usa una instancia global de `MemoryManager`; la web usa otra. TUI y server comparten la del server. Para WhatsApp podría ser útil memoria por chat (por `message.from`).  
  **Mejora:** Memoria por `chatId`/canal (por ejemplo un `MemoryManager` por conversación de WhatsApp) para que cada hilo tenga su propia ventana corta y su resumen, sin mezclar chats.

- **Persistencia del largo plazo:** El resumen largo se guarda en `MemoryManager` en memoria; al reiniciar el proceso se pierde.  
  **Mejora:** Persistir `longTerm` (por ejemplo en `data/memory/long-term.json` o por sesión) y cargarlo al arrancar para continuidad entre reinicios.

---

## 4. Cerebro (Agent, Planner, Executor, ContextBuilder)

- **Planner sin contexto de usuario:** El Planner solo recibe el objetivo; no recibe el perfil de usuario ni el workspace. Para planes más adaptados (por ejemplo “no tocar la carpeta X”), el plan podría tener en cuenta restricciones.  
  **Mejora:** Pasar al `plan()` un resumen corto de “restricciones o contexto” (por ejemplo una línea por usuario/workspace) y añadirla al prompt del planificador.

- **Eventos de tool_call en modo directo:** En el flujo `chatWithTools` (sin planner), las tool_calls las genera el LLM; no se hace `pushEvent("tool_call", { name, ... })` por cada llamada. Por tanto LoopDetector no ve esas repeticiones en modo web/TUI cuando no usan planner.  
  **Mejora:** En `vllmClient` (o donde se ejecutan las tools), emitir un evento o callback por cada tool call realizada para que el Agent (o un wrapper) haga `pushEvent("tool_call", { name, ... })` y el Health pueda detectar loops también en modo directo.

- **Presupuesto de tokens:** El `tokenBudget` es fijo (8000) en server/TUI/WhatsApp. Con conversaciones muy largas el contexto puede crecer mucho.  
  **Mejora:** Ajustar por longitud de `conversation` (por ejemplo reducir budget para mensajes recientes si hay muchos) o hacer el budget configurable (config o env).

- **Verifier:** Si existe un Verifier en el core, no se usa en el flujo actual. Revisar si debe integrarse (por ejemplo para validar que la respuesta final cumple el objetivo antes de devolverla).

---

## 5. WhatsApp

- **Estado y errores en la web:** La web ya puede mostrar QR y estado de WhatsApp. Mejorar mensajes cuando el bridge está en `auth_failure`, `disconnected` o `error` (texto claro y, si aplica, “Vuelve a escanear el QR” o “Reinicia el puente”).

- **Cola de mensajes:** Los mensajes se procesan en secuencia (`messageQueue`). Si un mensaje tarda mucho, los siguientes esperan.  
  **Mejora:** Mostrar en la web “Shiro está respondiendo a otro chat” o permitir un límite de concurrencia (ej. 2 chats a la vez) con cola por chat para no bloquear todo.

- **Límite de tiempo por mensaje:** Si el LLM o una tool se cuelga, el mensaje de WhatsApp puede quedar sin respuesta.  
  **Mejora:** Timeout por petición (ej. 60 s); si se cumple, responder algo como “No pude responder a tiempo; inténtalo de nuevo.” y registrar el error en Health.

- **Documentar variables:** `WA_ALLOWED_CHAT`, `WA_ONLY_PRIVATE`, `WA_REPLY_TO_OWN_MESSAGES`, `WA_CHROME_PATH` están en código; no están en README ni en COMANDOS.  
  **Mejora:** Añadir sección “WhatsApp” en README o COMANDOS con estas variables y su efecto.

---

## 6. Web y configuración

- **Configuración en la web:** Hoy la web tiene “Personalizar Shiro” (perfil de usuario). No permite cambiar modelo vLLM, URL ni habilidades; eso sigue siendo TUI/onboard.  
  **Mejora:** Sección “Configuración” en la web con: (1) Perfil (ya está), (2) Opcional: modelo y URL de vLLM (guardando en `config.json` vía API) y habilidades, con aviso “Reinicia o recarga para aplicar”. Así se unifica config en un solo sitio.

- **API de config:** No existe `GET/PUT /api/config` para leer/editar de forma segura (solo lo que el usuario deba cambiar: modelo, baseUrl, abilities).  
  **Mejora:** Endpoints `GET /api/config` (campos permitidos) y `PUT /api/config` (validar y escribir en `config.json`) para que la web pueda ofrecer formulario de configuración sin ejecutar TUI.

- **Health en la web:** Se muestra “Health: ok / idle / error” pero no se indica “safe_mode”.  
  **Mejora:** Incluir en `/api/health` un campo `safeMode: boolean` (o `status: "normal" | "safe_mode" | "paused"`) y en la UI un badge “Modo seguro” y, si se implementa, botón “Restaurar modo normal” que llame a `POST /api/health/restore` o similar.

- **Recarga de perfil:** Tras guardar “Personalizar Shiro”, el perfil se usa en el siguiente mensaje; no hace falta recargar. Si en el futuro la web cachea el perfil en el cliente, invalidar esa caché al guardar.

---

## Resumen prioritario

| Prioridad | Área        | Mejora concreta |
|----------|-------------|------------------|
| Alta     | Cerebro     | Emitir `tool_call` en modo directo (chatWithTools) para que LoopDetector funcione en web/TUI. |
| Alta     | Memoria     | Persistir resumen largo plazo para no perderlo al reiniciar. |
| Media    | Autonomía   | Salir de safe_mode desde web/TUI o tras tiempo sin errores. |
| Media    | WhatsApp    | Timeout por mensaje y documentar variables de entorno. |
| Media    | Web/config  | Exponer `GET/PUT /api/config` y opcionalmente pantalla de config (vLLM, habilidades) en la web. |
| Baja     | SOUL        | Mencionar en SOUL el uso de “Sobre el usuario” y del idioma preferido. |
| Baja     | Memoria     | openTasks en Summarizer y memoria por chat en WhatsApp. |

Si quieres, el siguiente paso puede ser implementar una de estas mejoras (por ejemplo persistencia de memoria larga o eventos `tool_call` en modo directo) y te guío en el código concreto.
