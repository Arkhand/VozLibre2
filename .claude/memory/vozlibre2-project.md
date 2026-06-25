---
name: vozlibre2-project
description: VozLibre2 — píldora flotante de transcripción de voz (Groq Whisper) en Electron para Windows
metadata:
  type: project
---

**VozLibre2** es una app de escritorio (Electron) para Windows: una **píldora flotante**
minimalista que transcribe voz a texto usando la API de **Groq Whisper**
(`whisper-large-v3`).

**Qué hace:** se mantiene presionado el orbe para grabar (Pointer Events), al soltar
manda el audio (`MediaRecorder` → webm/ogg) a Groq, y muestra la transcripción. Botones
Copiar / Limpiar y selector de idioma. Atajo de voz: mantené presionado = grabar.

**Diseño de la ventana (la "píldora"):**
- Ventana NATIVA de Electron: `frame:false`, `transparent:true`, `alwaysOnTop` con
  `setAlwaysOnTop(true, "screen-saver")`, `skipTaskbar:true`, `hasShadow:false`,
  `resizable:false`. Anclada arriba-derecha de la pantalla (24px de margen).
- En **reposo** es una **mini barra horizontal** (~360×64): orbe de grabar + estado +
  cerrar. Al transcribir (o ante un error) se **expande hacia abajo**: el renderer mide
  el alto real del contenido y pide a `main` que ajuste la ventana vía IPC
  (`pill:resize`). El ancho es fijo; solo crece el alto (tope `MAX_H=520`).
- Se arrastra desde la barra con `-webkit-app-region: drag` (los controles llevan
  `no-drag`).

**Es una app DISTINTA de la VozLibre original** (`C:\Users\musia\Desktop\VozLibre`):
aquella usa Chrome oculto + helper.py que teclea en cualquier app; VozLibre2 NO teclea,
solo transcribe y deja copiar. Comparten la idea de píldora flotante. Ver [[vozlibre-project]].

**Configuración (panel ⚙):** API key de Groq, micrófono (enumera `audioinput`),
idioma, **acción post-texto** y **atajo global**. Se persiste en `settings.json` vía
`src/settings.js` (por ahora JUNTO AL EXE; en dev = raíz del proyecto). `settings.json`
está en `.gitignore` (contiene la API key → NUNCA al repo). La key YA NO está
hardcodeada; al clonar hay que ponerla en el panel ⚙.

**Acciones post-texto** (`settings.action`): `show` (solo mostrar), `paste` (copia al
portapapeles + Ctrl+V con nut.js), `type` (teclea con nut.js). Usa
**`@nut-tree-fork/nut-js`** (módulo nativo) en el MAIN — verificado que teclea en otras
apps de Windows (probado con Notepad). `keyboard.config.autoDelayMs = 6` (0 perdía
teclas). El renderer NO toca nut.js: lo invoca por IPC (`text:paste`/`text:type`).

**Atajo global** (`settings.shortcut`, default `Control+Shift+Space`): `globalShortcut`
en el main; al pulsarlo hace TOGGLE grabar/parar (mantener-presionado no es viable a
nivel global). Se captura en la config leyendo `keydown` y se re-registra al guardar.

**UI colapsada:** en reposo la pildora es COMPACTA (solo orbe + ⚙ + ✕), `display:inline-block`
para encogerse al contenido. Se expande al grabar/transcribir (`has-result`) o abrir
config (`config-open`). El desplegable necesitaba `option { background: solid }` porque
si no se veía blanco sobre blanco.

**Cómo ejecutar:** `npm start` (o `npm install` la primera vez). Electron 26 instalado.

**IPC expuesto** (`src/preload.js` → `window.pill`): `close`, `resize`, `loadSettings`,
`saveSettings`, `paste`, `type`, `copyToClipboard`, `registerShortcut`,
`onShortcutToggle`.

**Idea futura:** minimizar a bandeja (tray) en vez de cerrar; ver cómo se comporta el
tecleo/atajo si la ventana está oculta.

Estructura de carpetas: ver [[project-structure]].
