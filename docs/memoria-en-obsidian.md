# La memoria de Aku en Obsidian

- **Fecha:** 26-10-2026
- **Regla:** todo lo que Aku lee antes de cada respuesta es una nota de la carpeta `Shiro/` de tu
  bóveda. Lo técnico (modelo, claves, conexiones) se queda en `data/` de tu PC.

Si cambias una nota en Obsidian, Aku lo usa en la siguiente respuesta. También puedes pedírselo
a él («apunta en tu memoria que…»).

## Qué hay en la carpeta `Shiro/`

```
Shiro/
├── Sobre mí.md         ← «Sobre ti» de Ajustes: tu nombre, idioma, qué saber de ti y cómo responderte
├── Instrucciones.md    ← instrucciones base (cómo usa las herramientas, sus reglas)
├── SOUL.md             ← su personalidad
├── MEMORY.md           ← lo importante que debe recordar siempre
├── TOOLS.md            ← consejos para elegir herramientas
├── Agentes/            ← una nota por agente de las salas (Viernes, Lunes…)
├── Recuerdos/          ← una nota por dato que guarda con memory_add
├── Chats/              ← copia de cada conversación (solo para leer)
├── Recordatorios.md    ← copia de los recordatorios (solo para leer)
└── …                   ← lo que Aku escriba con write_file (p. ej. portfolio/)
```

| Nota | ¿Aku la lee siempre? | ¿Se puede editar en Obsidian? |
|---|---|---|
| Sobre mí, Instrucciones, SOUL, MEMORY, TOOLS | Sí, en cada respuesta | Sí |
| Agentes/ | Cuando ese agente responde en una sala | Sí |
| Recuerdos/ | Cuando busca con memory_search | Sí |
| Chats/, Recordatorios.md | Cuando busca con memory_search | No: son copias. Para cambiar algo, pídeselo a Aku |

Aku solo ve la carpeta `Shiro/`, no el resto de tu bóveda.

### Cómo es la nota de un agente

```
---
id: viernes
nombre: "Viernes"
alias: ["Vie"]
modelo: "qwen/qwen3.5-9b"
herramientas: "todas"        ← "todas", "ninguna" o una lista
modo: "texto"                ← "texto" o "voz"
forma-de-ser: "añadir"       ← "añadir" a las instrucciones o "reemplazar"las
color: "#ff8800"
…
---
Aquí va su forma de ser, en texto normal.
```

- No cambies el `id`: las salas lo usan.
- Si escribes algo mal, Ajustes → Agentes te dice qué nota y por qué. Los demás agentes siguen funcionando.

## Lo que se queda en `data/` (tu PC)

- `config.json`: modelo, claves de API, Telegram, voz…
- `mcp.json`: conectores MCP (pueden llevar claves).
- Chats (el original), salas, proyectos y habilidades.
- `copia-obsidian/<bóveda>/`: **copia de seguridad automática** de lo que Aku lee de la bóveda
  (las notas principales, `Agentes/` y `Recuerdos/`). Se actualiza sola, como mucho una vez por minuto.

## Botón «Rehacer la estructura» (Ajustes → Datos)

Sirve por si borras o mueves algo de la carpeta `Shiro/` sin querer:

1. Vuelve a crear las notas que falten, sacándolas de la copia de `data/copia-obsidian/`
   (o con el texto por defecto si no hay copia).
2. Vuelve a escribir las copias de chats y `Recordatorios.md` que falten.
3. Quita lo que ya no se usa.

**Nunca cambia ni borra una nota que exista.** Si borraste un recuerdo a propósito, el botón lo
recupera de la copia: bórralo otra vez si no lo quieres.

## Lo que se quitó (ya no se usaba)

- `HEARTBEAT.md`: se borra solo si nadie lo cambió.
- `memory/`: sus notas pasan a `Recuerdos/` y la carpeta se borra.
- `data/user-profile.json`, `data/agents.json` y las instrucciones de `config.json`: pasan a sus
  notas la primera vez que abres Shiro y se borran.
