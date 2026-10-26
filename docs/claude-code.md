# Aku le pasa trabajo a Claude Code

- **Fecha:** 26-10-2026
- **Para qué:** Aku sigue con su modelo de siempre (LM Studio, Ollama…). Cuando le pides algo de
  programación en un **Proyecto**, puede encargárselo a **Claude Code**, el programa oficial de Anthropic,
  que usa tu suscripción (el plan Pro de 20 $ lo incluye, con sus límites de uso).

## Lo que necesitas (una sola vez)

1. Instalar Claude Code en Windows (mira la guía oficial: https://docs.claude.com/claude-code).
2. Abrir una terminal, escribir `claude` y, dentro, `/login` con tu cuenta de Claude.
3. En Shiro, crear un Proyecto y vincularle la carpeta de tu código.

Si tienes la variable `ANTHROPIC_API_KEY` puesta en Windows, Shiro **no** se la pasa a Claude Code:
así siempre usa tu suscripción y no la API (que se cobra aparte).

## Cómo se usa

En un chat del proyecto: «pídele a Claude Code que arregle el error del login», o «que Claude Code
añada pruebas a utils.ts».

- Aku te pide permiso (tarjeta Sí / No) antes de cada encargo, con el texto exacto que le va a pasar.
- Mientras trabaja, el panel **Terminal** muestra lo que hace (qué archivos lee, qué cambia…).
- Al terminar, Aku te resume lo que respondió Claude Code.
- «Sigue con lo de antes» → continúa la última conversación de Claude Code en esa carpeta.
- Para pararlo a mitad: el botón de parar del panel Terminal (puede dejar cambios a medias).
- Tarda como mucho 20 minutos por encargo (se puede pedir hasta 60).

## Qué puede hacer Claude Code

- Leer y **cambiar archivos** de la carpeta del proyecto (`--permission-mode acceptEdits`).
- **No** ejecuta comandos (instalar, borrar…) salvo los que tú hayas permitido en la configuración de
  Claude Code (`.claude/settings.json` de esa carpeta o el tuyo en `~/.claude/`). Así no pasa nada sin que lo sepas.
- Solo trabaja en carpetas vinculadas a un Proyecto de Shiro; fuera de un proyecto la herramienta no aparece.

## Cómo está hecho (el plan, ya terminado)

1. `src/core/claudeCode/claudeCode.ts`: encontrar `claude` (PATH, `~/.local/bin`, el de npm), armar los
   argumentos, leer su salida `stream-json` y traducir los errores (sin instalar, sin iniciar sesión,
   límite del plan) al español. Sin intérprete de comandos y sin claves de Shiro en el entorno.
2. Herramienta `claude_code` (`ToolRegistry.ts`, `schemas.ts`, `modules/claudeCode.ts`): `task`, `folder`
   (carpeta del proyecto), `continue`, `timeout_minutes`. Categoría PC: solo donde se puede pedir permiso
   (web y terminal), nunca en WhatsApp ni Telegram. Pide permiso siempre (`describeRiskyAction`).
3. Solo se ofrece en chats de un proyecto y si Claude Code está instalado (`Agent.ts`). También en el perfil
   «lite» de los modelos locales.
4. Panel Terminal: un bloque «Claude Code» con su progreso (`terminal.external()`); la web abre el panel sola y el botón de parar lo detiene.
5. `npm run doctor` dice si encontró Claude Code.
6. Pruebas con un `claude` falso (`src/core/claudeCode/claudeCode.test.ts`) y una prueba en Chromium de punta a punta; `AGENTS.md` y `README.md` al día.

## Probar sin gastar tu plan

`SHIRO_CLAUDE_PATH` puede apuntar a otro programa (o a un `.js`, que se lanza con node): así se prueba con un Claude Code falso.

## Lo que no hace (a propósito)

- No usa tu suscripción como «cerebro» de Aku: eso iría contra las condiciones de Anthropic.
  Para que Aku piense con Claude hace falta una clave de API (de pago, aparte).
