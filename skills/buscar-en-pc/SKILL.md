---
name: buscar-en-pc
description: "Buscar o encontrar archivos y carpetas en el PC por nombre o por contenido, localizar documentos o ver qué ocupa espacio en el disco."
---

# Buscar en el PC

Shiro no tiene una herramienta propia para buscar en todo el equipo: se busca con `terminal` (action=run). Solo se busca y se lee; no borres ni muevas nada si no te lo pidieron.

1. Empieza por la carpeta más probable (Documentos, Descargas, Escritorio, la del proyecto). Busca en todo el disco solo si ahí no aparece.
2. Limita los resultados para no llenar la conversación.
3. Si la búsqueda tarda, usa `timeout_seconds` más alto y mira cómo va con action=read.
4. Responde con las rutas completas de lo que encontraste. Para leer uno, usa `read_file_system` si lo tienes o la terminal.

## Windows (PowerShell)

```powershell
# Por nombre
Get-ChildItem "$HOME\Documents" -Recurse -File -Filter "*factura*" -ErrorAction SilentlyContinue | Select-Object -First 30 FullName

# Por contenido
Get-ChildItem "$HOME\Documents" -Recurse -File -Include *.txt,*.md -ErrorAction SilentlyContinue | Select-String -Pattern "factura" -List | Select-Object -First 30 Path

# Los archivos más grandes
Get-ChildItem "$HOME" -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 20 FullName, @{n="MB";e={[math]::Round($_.Length/1MB)}}
```

## Linux y macOS (bash)

```bash
# Por nombre
find "$HOME" -type f -iname "*factura*" 2>/dev/null | head -30

# Por contenido
grep -rIl --exclude-dir=node_modules --exclude-dir=.git "factura" "$HOME/Documentos" 2>/dev/null | head -30

# Lo que más ocupa
du -ah "$HOME" 2>/dev/null | sort -rh | head -20
```

## Reglas

- Si no tienes `terminal`, dilo y pide activar el control del PC en Ajustes; no inventes resultados.
- En Docker solo se ve lo que hay dentro del contenedor, no el equipo.
- Cada comando le pide permiso al usuario salvo que él haya elegido otra cosa: pide lo justo.
