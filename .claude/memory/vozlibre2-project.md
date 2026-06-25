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

**Acciones post-texto** (`settings.action`): `show` (solo mostrar), `paste` (copia +
Ctrl+V con nut.js), `type` (teclea con SendInput Unicode vía PowerShell — acentos OK,
VDI/RDP OK, sin clipboard). nut.js (`@nut-tree-fork/nut-js`) solo se usa para el Ctrl+V
del `paste`. Detalle de bugs del tecleo en [[tecleo-sendinput]].

**Transcribir vs traducir (dos modos):** `transcribe` → `/audio/transcriptions` (idioma
de `settings.lang`). `translate` → `/audio/translations` (Groq traduce a INGLÉS
siempre; modelo `whisper-large-v3`, sin param `language`). El modo lo decide qué atajo
se usó. `sendToGroq(blob, mode)` en el renderer elige endpoint.

**Atajos globales PUSH-TO-TALK (mantener = grabar, soltar = transcribir/traducir):**
usan un hook de teclado de bajo nivel `src/keyhook.ps1` (`SetWindowsHookEx`
WH_KEYBOARD_LL) — NO el `globalShortcut` de Electron, que no detecta el keyup. Hay DOS:
`settings.shortcut` (dictar, default `Control+Shift+Space`) y `settings.shortcutTranslate`
(traducir a inglés, default `Control+Shift+E`). El main lanza UN proceso-hook por atajo
(`hooks[mode]`), parsea el acelerador a `-Key/-Ctrl/-Shift/-Alt/-Win`, y el hook imprime
`DOWN`/`UP` → `pill:ptt-down/up` con el modo. `keyhook.ps1` mapea símbolos (`/`, `.`…)
con `VkKeyScan` (no solo letras). OJO: la tecla **Win** como atajo abre el menú Inicio
al soltar (efecto molesto). El hook se mata con `taskkill /T` al cerrar.

**Detección de silencio (no gastar API):** mientras graba, mide RMS del micro con Web
Audio API (`SILENCE_THRESHOLD = 0.012`). Si nunca superó el umbral → NO llama a Groq y
avisa "🔇 No se detectó voz". `hadVoice` en el renderer.

**UI colapsada:** en reposo la pildora es COMPACTA (orbe + ⚙ + ✕), `display:inline-block`.
Se expande al grabar/transcribir (`has-result`) o abrir config (`config-open`). El
desplegable necesitaba `option { background: solid }` (si no, blanco sobre blanco). La
píldora hace `setFocusable(false)` para no robar foco (si no, el tecleo no cae en tu app);
solo es focusable con la config abierta. La sombra NO usa box-shadow/drop-shadow proyectada
(deja halo cuadrado en fondos blancos): solo bordes inset.

**Cómo ejecutar:** `npm start` (o `npm install` la primera vez). Electron 26 instalado.

**IPC expuesto** (`src/preload.js` → `window.pill`): `close`, `resize`, `loadSettings`,
`saveSettings`, `paste`, `type`, `copyToClipboard`, `setFocusable`, `testAction`,
`registerShortcut`, `onPttDown`, `onPttUp`.

**Repo GitHub:** `Arkhand/VozLibre2` (privado). `settings.json` ignorado (tiene la API key).

**Idea futura:** minimizar a bandeja (tray) en vez de cerrar; ver cómo se comporta el
tecleo/atajo si la ventana está oculta.

Estructura de carpetas: ver [[project-structure]].
