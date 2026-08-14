/* VozLibre2 — IPC (pegamento entre el renderer y los módulos del main)
 * ====================================================================
 * Registra todos los ipcMain handlers/listeners y conecta los módulos:
 * window (ventana), settings (config), hotkeys (atajos), typing (pegar/teclear).
 * Se llama una vez desde main.js (registerIpc).
 */

const { ipcMain, clipboard, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const hotkeys = require("./hotkeys");
const typing = require("./typing");
const windowMod = require("./window");

// Formatos que acepta Whisper de Groq. .ogg/.opus son los de las notas de voz de
// WhatsApp; el resto entra igual porque el endpoint los soporta.
const AUDIO_EXTS = ["ogg", "opus", "oga", "m4a", "mp3", "mp4", "wav", "webm", "mpeg", "mpga", "flac"];

// Límite de la API de Groq (25 MB). Cortamos acá para no gastar una subida que va
// a fallar del otro lado con un error mucho menos claro.
const MAX_BYTES = 25 * 1024 * 1024;

// Lee un audio del disco y lo devuelve como bytes para que el renderer arme el Blob
// y lo mande a Groq con el mismo camino que una grabación.
function readAudioFile(filePath) {
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) {
      return { ok: false, error: `Formato no soportado (.${ext}). Usá ${AUDIO_EXTS.join(", ")}.` };
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return { ok: false, error: "El archivo está vacío." };
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `El archivo pesa ${(stat.size / 1048576).toFixed(1)} MB y el máximo de Groq es 25 MB.` };
    }
    const buf = fs.readFileSync(filePath);
    // Uint8Array viaja por IPC como bytes (estructurado), sin pasar por base64.
    return { ok: true, name: path.basename(filePath), ext, bytes: new Uint8Array(buf) };
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "El archivo ya no está en esa ubicación." };
    if (e.code === "EACCES" || e.code === "EPERM") return { ok: false, error: "Sin permisos para leer ese archivo." };
    return { ok: false, error: "No se pudo leer el archivo: " + e.message };
  }
}

function registerIpc() {
  // ---- Ventana ----
  // La ✕ ya NO cierra la app: oculta la píldora al tray. Para salir de verdad,
  // usar "Salir" en el menú del icono de la bandeja.
  ipcMain.on("pill:close", () => { windowMod.hide(); });
  ipcMain.on("pill:resize", (_e, height) => windowMod.resizeTo(height));

  // ---- Config (settings) ----
  ipcMain.handle("settings:load", () => settings.load());
  ipcMain.handle("settings:save", (_e, partial) => {
    const next = settings.save(partial);
    // Si cambió algún atajo, re-registrar ambos en el hook.
    const touchedShortcut = partial && (
      Object.prototype.hasOwnProperty.call(partial, "shortcut") ||
      Object.prototype.hasOwnProperty.call(partial, "shortcutTranslate")
    );
    if (touchedShortcut) hotkeys.register(next);
    return next;
  });

  // ---- Acciones de texto (pegar / teclear / portapapeles) ----
  ipcMain.handle("text:paste", (_e, text) => typing.pasteText(text));
  ipcMain.handle("text:type", (_e, text) => typing.typeText(text));
  ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(text); return { ok: true }; });

  // Config abierta: la píldora toma foco (para escribir) Y se DESACTIVAN los atajos
  // (si no, al asignar un atajo presionando la combinación se dispararía la grabación).
  // Al cerrar, se re-registran.
  ipcMain.on("pill:focusable", (_e, on) => {
    windowMod.setFocusable(on);
    if (on) hotkeys.disable();
    else hotkeys.register(settings.load());
  });

  // ---- Audio desde archivo (notas de voz de WhatsApp, etc.) ----
  // El diálogo es nativo (no <input type=file>) porque la píldora corre con
  // focusable=false y un input de archivo dentro de la ventana no se lleva bien
  // con eso. Se hace focusable mientras el diálogo está abierto y se restaura.
  ipcMain.handle("audio:pick", async () => {
    const win = windowMod.get();
    const wasFocusable = win ? win.isFocusable() : true;
    if (win && !wasFocusable) windowMod.setFocusable(true);
    hotkeys.disable(); // que el atajo no dispare grabación mientras elegís archivo
    try {
      const res = await dialog.showOpenDialog(win, {
        title: "Elegí un audio para transcribir",
        properties: ["openFile"],
        filters: [
          { name: "Audio", extensions: AUDIO_EXTS },
          { name: "Todos los archivos", extensions: ["*"] },
        ],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      return readAudioFile(res.filePaths[0]);
    } finally {
      if (win && !wasFocusable) windowMod.setFocusable(false);
      // Solo re-activamos atajos si la config no está tomando el foco.
      if (!wasFocusable) hotkeys.register(settings.load());
    }
  });

  // Drag & drop: el renderer solo puede pasarnos la ruta del archivo soltado.
  ipcMain.handle("audio:read", (_e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "Ruta inválida." };
    return readAudioFile(filePath);
  });

  // ---- Atajos ----
  ipcMain.handle("shortcut:register", () => hotkeys.register(settings.load()));
  ipcMain.handle("shortcut:capture", () => hotkeys.capture());

  // ---- Modo prueba: dispara la acción con texto fijo, sin gastar API ----
  // Da 1.5 s para que pongas el foco en tu app destino (Notepad/Word/VDI).
  ipcMain.handle("test:action", async (_e, action) => {
    const sample = "Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123";
    await new Promise((r) => setTimeout(r, 1500));
    if (action === "paste") return typing.pasteText(sample);
    return typing.typeText(sample);
  });
}

module.exports = { registerIpc };
