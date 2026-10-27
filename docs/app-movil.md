# Shiro en el móvil (app Android con Expo)

- **Fecha:** 26-10-2026
- **Para qué:** hablar con tu Shiro desde el teléfono **aunque el PC esté apagado**. La app piensa con
  **Ollama Cloud** y guarda todo en tu **Supabase**, el mismo que usa Shiro en el PC: chats, recuerdos y
  notas de memoria (MEMORY.md, «Sobre mí», SOUL.md, instrucciones). Lo que le cuentes en un sitio lo sabe en el otro.

## Lo que necesitas (una sola vez)

1. **Supabase en el PC:** en Shiro, Ajustes → Datos → «En Supabase». Copia el SQL que sale ahí, pégalo en
   Supabase → SQL Editor y pulsa Run (si ya lo tenías, ejecútalo otra vez: hay una tabla nueva, `shiro_notes`).
   Al guardar, «Llevar mis datos» sube tus chats, recuerdos y notas.
2. **Ollama Cloud:** crea una cuenta en ollama.com y una API key en https://ollama.com/settings/keys.
   - Si quieres que Shiro del PC también use Ollama Cloud: Ajustes → Modelo → «Ollama Cloud», pega la clave
     y elige un modelo (por ejemplo `gpt-oss:120b`). No necesitas GPU ni tener Ollama abierto.
3. **El .apk:** en GitHub, pestaña **Actions** → «App Android (APK)» → **Run workflow** (o se ejecuta solo al
   subir cambios de `mobile/`). Tarda unos 15 minutos. Al terminar, abre la ejecución y baja
   **shiro-android-apk** (un .zip con el .apk dentro). Pásalo al teléfono e instálalo (Android pedirá permitir
   «instalar apps desconocidas» para el navegador o el gestor de archivos).
4. Abre la app y rellena: la dirección y la clave secreta de Supabase (las mismas del PC), tu API key de
   Ollama Cloud y el modelo («Ver modelos» enseña la lista). «Probar y empezar» comprueba todo.

## Cómo se ve

Igual que Shiro de escritorio en una pantalla estrecha:
- Barra de arriba: botón de la barra lateral, el nombre con el modelo (tócalo para cambiar de modelo de Ollama Cloud), luna/sol para el tema y nuevo chat (o los tres puntos de un chat abierto: nuevo, renombrar, borrar).
- Barra lateral, que se desliza desde la izquierda: «Nuevo chat», «Buscar chats», «Modo voz», «Recordatorios», los chats agrupados por fecha (Hoy, Ayer…) y abajo tu nombre con Ajustes.
- Portada «¿En qué puedo ayudarte?» con la capibara y sugerencias. Los mensajes, los pasos («1 acción») y el cuadro de texto son como en la web.
- Mensajes: Copiar, Leer en voz alta y Regenerar en las respuestas; Copiar y Editar en los tuyos. Tablas y código con colores.
- Cuadro de texto: + (fotos de la galería, hacer una foto, archivo de texto), micrófono para dictar, y el botón redondo
  (modo voz si está vacío, enviar si hay algo). Al escribir «/» sale el menú de comandos (/ayuda, /nuevo, /modelo, /recordatorios, /voz, /ajustes).

## Cómo funciona

- **Chats:** los del PC salen en la lista y los del móvil salen en el PC (misma tabla `shiro_chats`).
  Mantén pulsado un chat para borrarlo (también se borra en el PC).
- **Memoria:** el asistente lee en cada mensaje tus notas de Supabase y puede usar `memory_search` y
  `memory_add` (los recuerdos importantes se apuntan también en MEMORY.md).
- **Internet:** `search_web` y `fetch_url` usan la búsqueda web de Ollama, con la misma API key.
- **Recordatorios:** los mismos del PC (tabla `shiro_reminders`). Se crean en la pantalla Recordatorios o pidiéndoselo
  («recuérdame tomar agua en 1 hora»: `create_reminder`, `list_reminders`, `complete_reminder`). El teléfono avisa de los
  pendientes con una notificación; los creados en el PC se programan la próxima vez que abras la app.
- **Voz:** el micrófono usa el reconocimiento de voz de Android (el de Google) y la lectura en voz alta, la voz del teléfono.
  En el modo voz, la esfera dorada escucha, piensa (azul) y responde corto; tócala para interrumpir.
- **Fotos y archivos:** las fotos se reducen a 1600 px (como en la web) y van al modelo; para que las entienda, elige un
  modelo de Ollama Cloud que vea imágenes. Los archivos de texto van dentro del mensaje. Las fotos de los chats del PC también se ven.
- **Personalización** (Ajustes → Personalización): «Sobre ti», instrucciones base, SOUL.md, MEMORY.md y TOOLS.md. Se guardan en
  Supabase y el PC los recibe en unos segundos.
- **Lo que no hace en el móvil:** controlar el PC, leer sus archivos, la terminal, el navegador de Shiro, Claude Code,
  Proyectos, salas, habilidades, conectores MCP ni modelos locales. Para eso, Shiro del PC.
- **PC ↔ Supabase:** Shiro del PC sincroniza sus notas al arrancar, cada 20 segundos y justo después de
  cambiarlas. Si una nota cambia en los dos sitios a la vez, MEMORY.md junta las líneas de ambos y el resto
  se queda con la versión más nueva.

## Seguridad

- La clave secreta de Supabase abre todos tus datos: la app la guarda cifrada en el teléfono
  (`expo-secure-store`). Si pierdes el móvil, crea otra clave en Supabase y cámbiala en el PC.
- El APK lo compila GitHub con la firma de pruebas de Expo: sirve para instalarlo tú, no para la Play Store.

## Probar sin teléfono

```bash
cd mobile
npm install
npm run web        # la app en el navegador (las claves quedan en localStorage)
npm start          # con la app Expo Go del móvil: escanea el código QR
npm run check      # tipos
npm test           # pruebas de la lógica (Supabase y Ollama falsos)
```

## Cómo está hecho

- `mobile/` es una app de Expo (React Native, TypeScript) aparte del resto: tiene su `package.json`.
- `mobile/src/core/`: la lógica sin pantallas, probada con `node:test`:
  `supabase.ts` (chats, recuerdos y notas con el mismo formato que el PC), `ollama.ts` (Ollama Cloud: chat por
  líneas JSON, modelos, búsqueda web), `prompt.ts` (el system prompt con tus notas), `agent.ts` (herramientas y bucle).
- `mobile/src/screens/`: `MainScreen.tsx` (barra de arriba, portada, mensajes, comandos, editar/regenerar), `SettingsScreen.tsx`, `RemindersScreen.tsx` y `PersonalizationScreen.tsx`; las piezas en `mobile/src/ui/` (`Sidebar`, `Message`, `Composer`, `Markdown`, `Icon`, `VoiceOverlay`). En `mobile/src/`: `voice.ts` (dictado y lectura), `notifications.ts` (avisos) y `attachments.ts` (fotos y archivos). En `src/core/`, además: `reminders.ts`, `content.ts` (adjuntos con el formato de la web), `commands.ts` y `highlight.ts`. Colores en `src/theme.ts`, copiados de `public/css/app.css`. `expo/fetch` deja leer la respuesta mientras llega.
- En el PC: `src/storage/notesSync.ts` (notas ↔ `shiro_notes`) y el proveedor `ollama-cloud` en `src/core/llm/providers.ts`.
- `.github/workflows/android-apk.yml`: `npm ci`, tipos, pruebas, `expo prebuild` y `gradlew assembleRelease` (solo arm64).
