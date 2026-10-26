# App del móvil de Shiro (Expo)

Guía completa: `../docs/app-movil.md`. El usuario no es programador: explica en español y en sencillo.

- Expo SDK 58 (React Native 0.88). Instala módulos con las versiones de `expo/bundledNativeModules.json`
  (`npx expo install` si hay internet para Expo). Sin Expo Router: tres pantallas en `src/screens/` y `App.tsx`.
- La lógica va en `src/core/` sin importar React Native (se prueba con `node:test`); las pantallas solo la llaman.
- Mismo formato que Shiro del PC en Supabase (`shiro_chats`, `shiro_memories`, `shiro_notes`): si cambias uno, cambia el otro.
- No crees `android/` ni `ios/` a mano: los genera `expo prebuild` (en GitHub Actions).
- Antes de terminar: `npm run check` y `npm test`.
