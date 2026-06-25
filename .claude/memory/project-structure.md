---
name: project-structure
description: Estructura de carpetas limpia de VozLibre2 (Electron) — mantenerla siempre así
metadata:
  type: project
---

**Estructura limpia de VozLibre2** (Electron, sin framework de bundling). Sigue las
best practices de separar main / preload / renderer. MANTENER siempre así: no mezclar
lógica de renderer en la raíz, no dejar archivos duplicados sueltos.

```
VozLibre2/
├─ package.json        # main: "main.js", script start: "electron ."
├─ main.js             # PROCESO PRINCIPAL: crea la ventana píldora (frameless,
│                      #   transparent, alwaysOnTop, skipTaskbar) + IPC de
│                      #   redimensionado (pill:resize) y cierre (pill:close).
├─ .gitignore          # node_modules/, dist/, caches…
├─ settings.json       # CONFIG del usuario (API key, etc.) — IGNORADO por git.
├─ src/
│  ├─ preload.js       # PRELOAD: expone window.pill (close, resize, settings,
│  │                   #   paste/type, shortcut) por contextBridge (contextIsolation).
│  ├─ settings.js      # PERSISTENCIA: load/save de settings.json (junto al exe).
│  └─ renderer/        # RENDERER (UI): la píldora.
│     ├─ index.html    #   barra (orbe/estado/cerrar) + panel expandible (resultado).
│     ├─ renderer.js   #   grabación (MediaRecorder) → Groq Whisper → expandir/medir.
│     └─ style.css     #   diseño glass/píldora, transparente, expansión.
└─ .claude/
   └─ memory/          # memoria del proyecto versionada en GitHub (este archivo).
```

**Reglas:**
- `main.js` en la raíz es el único punto de entrada (lo apunta `package.json`).
- Todo lo del renderer vive bajo `src/renderer/`. El preload bajo `src/`.
- NUNCA dejar `index.html` / `main.js` duplicados en la raíz "sueltos" (ya pasó: había
  un index.html inline duplicado en la raíz que se eliminó).
- Comunicación renderer↔main SOLO por IPC vía preload (contextBridge), nunca exponer
  Node directo al renderer.

Detalle de qué es la app: ver [[vozlibre2-project]].
