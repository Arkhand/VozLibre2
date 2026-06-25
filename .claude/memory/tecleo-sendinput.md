---
name: tecleo-sendinput
description: Bugs clave del tecleo Unicode (SendInput) en VozLibre2 — struct 40 bytes + STDIN UTF-8
metadata:
  type: project
---

El tecleo "Simular pulsaciones de teclado" de VozLibre2 usa **SendInput con
KEYEVENTF_UNICODE** desde `src/type-unicode.ps1` (PowerShell, invisible vía
`windowsHide`). Elegido porque nut.js se come los acentos y el Ctrl+V usa el
portapapeles (bloqueado en VDI/RDP). Verificado por el usuario: teclea
`áéíóú ñÑ ¿Está? ¡Sí! 123` correcto en apps de Windows.

**DOS bugs que lo rompían (ya resueltos — no reintroducir):**

1. **Struct `INPUT` debe medir 40 bytes en x64.** Si el union no reserva el tamaño
   de `MOUSEINPUT` (32B), el struct mide 32 y `SendInput` devuelve 0 con
   `lastErr=87` (ERROR_INVALID_PARAMETER) → **no teclea nada**. Fix: en el
   `LayoutKind.Explicit`, poner `MOUSEINPUT mi` y `KEYBDINPUT ki` ambos a
   `[FieldOffset(8)]` (8 = 4 de `type` + 4 de padding x64). Diagnóstico:
   `size=32 sent=0 lastErr=87` → tras fix → `size=40 sent=36 lastErr=0`.

2. **STDIN debe leerse como UTF-8 explícito.** `[Console]::In.ReadToEnd()` usa la
   codificación de consola (CP850/Latin-1 en es-AR) y rompe acentos: `á` (bytes
   `C3 A1`) sale como `├í`. Fix: leer con
   `StreamReader([Console]::OpenStandardInput(), UTF8Encoding(false))`. El texto
   se manda desde el main con `ps.stdin.write(Buffer.from(text,"utf8"))`.

**Fix de foco relacionado:** la píldora hace `win.setFocusable(false)` +
`showInactive()` para NO robar el foco. Si lo robara, el tecleo/Ctrl+V caería en la
propia ventana de Electron y no en la app del usuario. Solo se hace focusable
mientras la config está abierta (para escribir la API key).

**Modo prueba:** botón 🧪 en la config dispara la acción con texto fijo (sin gastar
API), con 1,5 s para enfocar la app destino. IPC `test:action`.

Ver [[vozlibre2-project]].
