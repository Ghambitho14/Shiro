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

## Cómo funciona

- **Chats:** los del PC salen en la lista y los del móvil salen en el PC (misma tabla `shiro_chats`).
  Mantén pulsado un chat para borrarlo (también se borra en el PC).
- **Memoria:** el asistente lee en cada mensaje tus notas de Supabase y puede usar `memory_search` y
  `memory_add` (los recuerdos importantes se apuntan también en MEMORY.md).
- **Internet:** `search_web` y `fetch_url` usan la búsqueda web de Ollama, con la misma API key.
- **Lo que no hace en el móvil:** controlar el PC, leer sus archivos, la terminal, Claude Code, salas,
  recordatorios con aviso ni voz. Para eso, Shiro del PC.
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
- `mobile/src/screens/`: Ajustes, lista de chats y chat. `expo/fetch` deja leer la respuesta mientras llega.
- En el PC: `src/storage/notesSync.ts` (notas ↔ `shiro_notes`) y el proveedor `ollama-cloud` en `src/core/llm/providers.ts`.
- `.github/workflows/android-apk.yml`: `npm ci`, tipos, pruebas, `expo prebuild` y `gradlew assembleRelease` (solo arm64).
