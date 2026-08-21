/* VozLibre2 — Preload
 * ====================
 * Puente seguro entre la pildora (renderer) y el proceso principal.
 * Expone window.pill con: ventana (close/resize), settings, acciones de texto
 * (paste/type/clipboard), atajo global y el evento de toggle por atajo.
 */

const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

// Ruta en disco de un archivo soltado (drag & drop). Hasta Electron 31 alcanzaba
// con File.path; desde la 32 hay que pedirla por webUtils. Soportamos las dos para
// que actualizar Electron no rompa el drop.
function filePathOf(file) {
  try {
    if (electron.webUtils?.getPathForFile) return electron.webUtils.getPathForFile(file);
  } catch { /* seguimos con File.path */ }
  return file?.path || "";
}

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

  // Audio desde archivo: diálogo nativo (📎) y lectura por ruta (drag & drop).
  // Ambos resuelven {ok, name, ext, bytes} | {ok:false, error|canceled}.
  pickAudio: () => ipcRenderer.invoke("audio:pick"),
  readAudio: (filePath) => ipcRenderer.invoke("audio:read", filePath),
  // Analiza el archivo sin convertirlo: duración, si es video y en cuántas partes
  // saldría. El renderer con esto decide si preguntar antes de gastar API.
  planAudio: (filePath) => ipcRenderer.invoke("audio:plan", filePath),
  // Resuelve la ruta de un File soltado y lo analiza (el renderer no puede sacar
  // la ruta por su cuenta con contextIsolation).
  planDroppedAudio: (file) => {
    const p = filePathOf(file);
    if (!p) return Promise.resolve({ ok: false, error: "Arrastrá el archivo desde una carpeta del disco." });
    return ipcRenderer.invoke("audio:plan", p);
  },
  // Extrae audio del video, comprime a Opus y parte en trozos por silencios.
  prepareAudio: (filePath) => ipcRenderer.invoke("audio:prepare", filePath),
  cleanupAudio: (tmpDir) => ipcRenderer.invoke("audio:cleanup", tmpDir),
  ffmpegStatus: () => ipcRenderer.invoke("audio:ffmpeg-status"),
  // Avance de la conversión (ffmpeg tarda con archivos largos).
  onAudioProgress: (cb) => ipcRenderer.on("audio:progress", (_e, p) => cb(p)),

  // Formateo a Markdown (Claude CLI, en el main: el renderer no puede spawnear).
  formatStatus: () => ipcRenderer.invoke("format:status"),
  formatRecheck: () => ipcRenderer.invoke("format:recheck"),
  formatTranscript: (payload) => ipcRenderer.invoke("format:transcript", payload),
  onFormatProgress: (cb) => ipcRenderer.on("format:progress", (_e, p) => cb(p)),

  // Historial de transcripciones de archivo (.md en la carpeta elegida + índice).
  historySave: (payload) => ipcRenderer.invoke("history:save", payload),
  historyList: () => ipcRenderer.invoke("history:list"),
  historyRead: (id) => ipcRenderer.invoke("history:read", id),
  historyRemove: (id, alsoFile) => ipcRenderer.invoke("history:remove", id, alsoFile),
  historyOpen: (id) => ipcRenderer.invoke("history:open", id),
  historyReveal: (id) => ipcRenderer.invoke("history:reveal", id),
  historyFolder: () => ipcRenderer.invoke("history:folder"),
  historyPickFolder: () => ipcRenderer.invoke("history:pick-folder"),
  historyOpenFolder: () => ipcRenderer.invoke("history:open-folder"),

  // Atajo global
  registerShortcut: (accelerator) => ipcRenderer.invoke("shortcut:register", accelerator),
  // Captura nativa del atajo (uiohook): resuelve con {ok, bind:{keycode,ctrl,...}}.
  captureShortcut: () => ipcRenderer.invoke("shortcut:capture"),

  // Push-to-talk global: el main avisa keydown/keyup del atajo (hook de teclado),
  // con el modo: "transcribe" (idioma config) | "translate" (→ inglés).
  onPttDown: (cb) => ipcRenderer.on("pill:ptt-down", (_e, mode) => cb(mode)),
  onPttUp: (cb) => ipcRenderer.on("pill:ptt-up", (_e, mode) => cb(mode)),
});
