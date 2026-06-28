/* VozLibre2 — Preload
 * ====================
 * Puente seguro entre la pildora (renderer) y el proceso principal.
 * Expone window.pill con: ventana (close/resize), settings, acciones de texto
 * (paste/type/clipboard), atajo global y el evento de toggle por atajo.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pill", {
  // Ventana
  close: () => ipcRenderer.send("pill:close"),
  resize: (height) => ipcRenderer.send("pill:resize", height),

  // Settings (persistencia)
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),

  // Acciones con el texto reconocido
  paste: (text) => ipcRenderer.invoke("text:paste", text),
  type: (text) => ipcRenderer.invoke("text:type", text),
  copyToClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),

  // Foco (la config lo pide para poder escribir; en reposo la pildora no roba foco).
  setFocusable: (on) => ipcRenderer.send("pill:focusable", on),

  // Modo prueba: dispara la acción con texto fijo (sin gastar API).
  testAction: (action) => ipcRenderer.invoke("test:action", action),

  // Atajo global
  registerShortcut: (accelerator) => ipcRenderer.invoke("shortcut:register", accelerator),
  // Captura nativa del atajo (uiohook): resuelve con {ok, bind:{keycode,ctrl,...}}.
  captureShortcut: () => ipcRenderer.invoke("shortcut:capture"),

  // Push-to-talk global: el main avisa keydown/keyup del atajo (hook de teclado),
  // con el modo: "transcribe" (idioma config) | "translate" (→ inglés).
  onPttDown: (cb) => ipcRenderer.on("pill:ptt-down", (_e, mode) => cb(mode)),
  onPttUp: (cb) => ipcRenderer.on("pill:ptt-up", (_e, mode) => cb(mode)),
});
