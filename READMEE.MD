# Shiro

**Shiro** es un asistente conversacional que corre en tu máquina. Hablas con él por **terminal**, **navegador** o **WhatsApp**. Usa un modelo local (vLLM) con opción de herramientas (leer/escribir archivos en un workspace o en el sistema). Tiene memoria, detección de bucles y una “identidad” configurable (SOUL).

Ideal para tener un ayudante que entiende contexto, recuerda la conversación y puede ejecutar tareas en tu entorno sin depender de la nube.

---

## Qué necesitas

- **Node.js** 18 o superior
- **pnpm** (gestor de paquetes)
- **(Opcional pero recomendado)** Un servidor **vLLM** con un modelo que soporte tool calling, para que Shiro pueda leer/escribir archivos y planificar pasos

Si solo quieres probar el chat en texto (sin herramientas), puedes apuntar a cualquier API compatible con OpenAI (por ejemplo un vLLM básico sin tools).

---

## Instalación rápida

```bash
git clone <url-del-repo>
cd Shiro
pnpm install
```

La primera vez no hay configuración. Ejecuta:

```bash
pnpm onboard
```

Te guiará paso a paso: URL de vLLM, modelo, habilidades opcionales y al final te preguntará si quieres que Shiro “sepa algo de ti” (nombre, idioma, gustos). Todo se guarda en la carpeta `data/`.

Luego ya puedes usar Shiro.

---

## Cómo usar Shiro

Tres formas principales:

| Dónde | Comando | Qué hace |
|-------|---------|----------|
| **Terminal** | `pnpm tui` | Chat por consola. Escribe y Shiro responde. "salir" o "exit" para terminar. |
| **Navegador** | `pnpm run dev` | Servidor web en http://127.0.0.1:1406. Abre esa URL y chatea desde la interfaz. |
| **WhatsApp** | `pnpm wa` | Puente con WhatsApp Web: escaneas un QR y Shiro responde en un chat. |

### Comandos que más usarás

| Comando | Descripción |
|---------|-------------|
| `pnpm tui` | Chat en terminal |
| `pnpm run dev` | Web de chat (puerto 1406) |
| `pnpm run config` | Menú de configuración (modelo, vLLM, habilidades) |
| `pnpm onboard` | Configuración inicial (primera vez) |
| `pnpm personalize` | Decirle a Shiro cosas sobre ti (nombre, idioma, etc.) |
| `pnpm wa` | Conectar WhatsApp (muestra QR) |
| `pnpm test` | Ejecutar tests |

**Ayuda en terminal:** `pnpm start` (sin argumentos) o `pnpm start --help`.  
Lista completa de comandos: **[COMANDOS.md](COMANDOS.md)**.

---

## Configuración y datos

Todo lo que Shiro guarda está en la carpeta **`data/`** (se crea al usar la app):

| Archivo / carpeta | Qué es |
|-------------------|--------|
| `data/config.json` | URL de vLLM, modelo, habilidades. Se edita con `pnpm run config` o en la web (si se añade). |
| `data/state.json` | Estado interno (p. ej. nombre del asistente; por defecto siempre "Shiro"). |
| `data/user-profile.json` | Lo que Shiro sabe de ti: nombre, idioma, "sobre ti", notas. Se edita con `pnpm personalize` o en la web (Configuración → Personalizar Shiro). |
| `data/workspace/` | Workspace del agente (SOUL.md, MEMORY.md, memoria por fechas). |
| Sesiones de chat (web) | Guardadas en base SQLite por el servidor. |

**Variables de entorno** (opcionales):

| Variable | Uso |
|----------|-----|
| `PORT` | Puerto del servidor web (por defecto 1406). |
| `VLLM_BASE_URL` | URL del API vLLM (ej. http://127.0.0.1:8000/v1). |
| `VLLM_MODEL` | Nombre del modelo en vLLM. |
| `VLLM_API_KEY` | API key si tu servidor la exige. |

Si no existen, se usan los valores de `data/config.json` (que rellenas en onboard o config).

---

## Cómo funciona por dentro (para curiosos)

- **SOUL:** El “alma” del agente: quién es, estilo de respuesta y reglas (siempre texto, herramientas solo cuando haga falta). Está en `src/core/soul/soul.ts` y se inyecta en cada petición al modelo.
- **Memoria:** Ventana reciente de eventos (tool calls, observaciones, errores) más un resumen a largo plazo para no perder el hilo en conversaciones largas.
- **Health:** Detecta bucles (misma acción repetida, mismo error). Puede pasar a “modo seguro” (desactiva escritura en sistema) o pedirte que reformules.
- **Planner (opcional):** Para tareas complejas, Shiro puede generar una lista de pasos y ejecutarlos; en chat simple responde en un solo turno con o sin herramientas.

Flujo simplificado:

```
Tu mensaje → runAgent()
  → buildContext()   (SOUL + tu mensaje + memoria + herramientas si aplica)
  → checkAndIntervene()   (¿hay bucle? → aviso o safe_mode)
  → LLM (vLLM) con o sin tools
  → respuesta para ti
```

Estructura del código relevante:

```
src/
  core/
    agent/     Agent, Planner, Executor, ContextBuilder
    soul/      soul.ts (identidad), policies.ts
    memory/    MemoryManager, Summarizer
    health/    HealthManager, LoopDetector
    llm/       vllmClient (llamadas al modelo)
    tools/     leer/escribir archivos (workspace y sistema)
  config/      config.ts, carga de config.json
  server.ts    API HTTP para la web y WhatsApp
  index.ts     Entrada CLI (tui, config, onboard, wa, etc.)
  user-profile.ts, personalize.ts   Perfil de usuario
```

Más contexto para quien contribuya: **AGENTS.MD**.

---

## Tests

```bash
pnpm test
```

Incluye pruebas de ContextBuilder (presupuesto de tokens), LoopDetector (detección de bucles) y Summarizer (resumen de memoria).

---

## Problemas frecuentes

- **“El puerto 1406 ya está en uso”**  
  Otro proceso está usando ese puerto. En Windows: `netstat -ano | findstr :1406`, anota el PID y `taskkill /PID <PID> /F`. En Linux/Mac: `lsof -ti :1406 | xargs kill -9`. O usa otro puerto: `PORT=1407 pnpm run dev` (Linux/Mac) o `set PORT=1407 && pnpm run dev` (Windows).

- **“No tengo config” / primera vez**  
  Ejecuta `pnpm onboard` y sigue el asistente. Crea `data/config.json` y opcionalmente `data/user-profile.json`.

- **Shiro no responde o tarda mucho**  
  Comprueba que vLLM esté corriendo y que la URL en config sea correcta. En la web, el badge “Health” y “Modelo/Endpoint” te indican si el servidor ve la config.

- **Quiero cambiar modelo o URL**  
  `pnpm run config` en terminal o (si está implementado) la sección Configuración en la web.

---

## Resumen en una frase

**Clona → `pnpm install` → `pnpm onboard` → `pnpm run dev` y abre http://127.0.0.1:1406**, o usa `pnpm tui` para chat en terminal. Toda la configuración y datos están en `data/`; para más comandos mira [COMANDOS.md](COMANDOS.md).
 Fa