/* VozLibre2 — IPC (pegamento entre el renderer y los módulos del main)
 * ====================================================================
 * Registra todos los ipcMain handlers/listeners y conecta los módulos:
 * window (ventana), settings (config), hotkeys (atajos), typing (pegar/teclear).
 * Se llama una vez desde main.js (registerIpc).
 */

const { ipcMain, clipboard, dialog, shell, session, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const settings = require("./settings");
const hotkeys = require("./hotkeys");
const typing = require("./typing");
const windowMod = require("./window");
const audio = require("./audio");
const format = require("./format");
const history = require("./history");

// Formatos que acepta Whisper de Groq. .ogg/.opus son los de las notas de voz de
// WhatsApp; el resto entra igual porque el endpoint los soporta.
const AUDIO_EXTS = ["ogg", "opus", "oga", "m4a", "mp3", "mp4", "wav", "webm", "mpeg", "mpga", "flac"];

// Video: no se sube nunca tal cual (pesa muchísimo). Con ffmpeg se le extrae el
// audio; sin ffmpeg no hay nada que hacer y se avisa.
const VIDEO_EXTS = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "mpeg", "mpg", "3gp"];

// Extensiones que el diálogo ofrece: audio + video juntos.
const PICKABLE_EXTS = [...new Set([...AUDIO_EXTS, ...VIDEO_EXTS])];

// Límite de la API de Groq (25 MB). Cortamos acá para no gastar una subida que va
// a fallar del otro lado con un error mucho menos claro.
const MAX_BYTES = 25 * 1024 * 1024;

// Valida el archivo y decide CÓMO transcribirlo, sin convertir nada todavía.
// Devuelve el plan para que el renderer lo muestre y pida confirmación si hace
// falta (los archivos largos tardan y gastan API, así que no se arranca a ciegas):
//   { ok, name, ext, isVideo, needsFfmpeg?, direct?, duration?, parts?, sizeMB }
async function planAudioFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "El archivo ya no está en esa ubicación." };
    if (e.code === "EACCES" || e.code === "EPERM") return { ok: false, error: "Sin permisos para leer ese archivo." };
    return { ok: false, error: "No se pudo leer el archivo: " + e.message };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath);
  const known = AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext);
  // Provisorio por extensión: si hace falta ffprobe lo corrige con la verdad del
  // archivo (un .mp4 puede ser solo audio, y un .webm cualquiera de las dos cosas).
  let isVideo = VIDEO_EXTS.includes(ext) && !AUDIO_EXTS.includes(ext);

  if (!known) {
    return { ok: false, error: `Formato no soportado (.${ext}). Usá audio (${AUDIO_EXTS.join(", ")}) o video (${VIDEO_EXTS.join(", ")}).` };
  }
  if (stat.size === 0) return { ok: false, error: "El archivo está vacío." };

  const sizeMB = stat.size / 1048576;
  const base = { ok: true, name, ext, isVideo, sizeMB };

  // Camino rápido: audio chico y en un formato que Groq acepta tal cual. Se sube
  // sin tocar, así una nota de voz de WhatsApp no depende de tener ffmpeg.
  if (!isVideo && stat.size <= MAX_BYTES && !audio.isAvailable()) {
    return { ...base, direct: true };
  }
  const chunkMinutes = settings.load().chunkMinutes;

  if (!isVideo && stat.size <= MAX_BYTES) {
    // Con ffmpeg disponible igual medimos la duración: si es largo hay que partirlo
    // aunque pese poco (Opus comprime tanto que 1 h entra en pocos MB).
    const info = await audio.inspect(filePath, chunkMinutes);
    if (!info.ok) return { ...base, direct: true }; // no se pudo medir: intentamos directo
    if (info.parts <= 1) {
      return { ...base, direct: true, duration: info.duration, parts: 1 };
    }
    return { ...base, isVideo: !!info.hasVideo, direct: false, duration: info.duration, parts: info.parts };
  }

  // A partir de acá hace falta ffmpeg sí o sí: es video, o pesa más de 25 MB.
  if (!audio.isAvailable()) {
    // Sin ffmpeg no podemos mirar dentro del archivo, así que acá la extensión es
    // todo lo que tenemos para explicar por qué hace falta.
    const motivo = VIDEO_EXTS.includes(ext)
      ? `Es un video (.${ext}), así que hay que extraerle el audio.`
      : `Pesa ${sizeMB.toFixed(1)} MB y el máximo de Groq es 25 MB, así que hay que comprimirlo.`;
    return { ok: false, needsFfmpeg: true, name, error: `${motivo} ${audio.INSTALL_HINT}` };
  }

  const info = await audio.inspect(filePath, chunkMinutes);
  if (!info.ok) return { ok: false, needsFfmpeg: info.needsFfmpeg, name, error: info.error };
  return { ...base, isVideo: !!info.hasVideo, direct: false, duration: info.duration, parts: info.parts };
}

// Lee un audio tal cual del disco (camino directo, sin ffmpeg).
function readAudioFile(filePath) {
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
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

  // ---- Audio desde archivo (notas de voz, grabaciones largas, video) ----
  // Flujo: pick/plan -> (el renderer confirma si es largo) -> prepare -> partes.
  //
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
        title: "Elegí un audio o video para transcribir",
        properties: ["openFile"],
        filters: [
          { name: "Audio y video", extensions: PICKABLE_EXTS },
          { name: "Audio", extensions: AUDIO_EXTS },
          { name: "Video", extensions: VIDEO_EXTS },
          { name: "Todos los archivos", extensions: ["*"] },
        ],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      const p = await planAudioFile(res.filePaths[0]);
      return { ...p, path: res.filePaths[0] };
    } finally {
      if (win && !wasFocusable) windowMod.setFocusable(false);
      // Solo re-activamos atajos si la config no está tomando el foco.
      if (!wasFocusable) hotkeys.register(settings.load());
    }
  });

  // Drag & drop: el renderer solo puede pasarnos la ruta del archivo soltado.
  ipcMain.handle("audio:plan", async (_e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "Ruta inválida." };
    const p = await planAudioFile(filePath);
    return { ...p, path: filePath };
  });

  // Camino directo: audio chico que Groq acepta tal cual, sin pasar por ffmpeg.
  ipcMain.handle("audio:read", (_e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "Ruta inválida." };
    return readAudioFile(filePath);
  });

  // Camino largo: extrae audio del video, comprime a Opus y parte en trozos
  // cortando en silencios. Informa el avance por "audio:progress" porque un
  // archivo de 1 h tarda y la píldora tiene que mostrar algo mientras tanto.
  ipcMain.handle("audio:prepare", async (e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "Ruta inválida." };
    const send = (payload) => {
      if (!e.sender.isDestroyed()) e.sender.send("audio:progress", payload);
    };
    const r = await audio.prepare(filePath, send, settings.load().chunkMinutes);
    if (!r.ok) return r;
    // tmpDir vuelve al renderer solo para que pueda pedir su borrado al terminar.
    return { ok: true, tmpDir: r.tmpDir, duration: r.duration, parts: r.parts };
  });

  // Borra los temporales una vez transcriptas todas las partes.
  ipcMain.handle("audio:cleanup", (_e, tmpDir) => {
    // Solo permitimos borrar directorios que creamos nosotros (mkdtemp en el temp
    // del sistema con prefijo vozlibre-). Sin este chequeo, un tmpDir manipulado
    // podría borrar cualquier carpeta del disco.
    if (typeof tmpDir !== "string") return { ok: false };
    const base = fs.realpathSync(os.tmpdir());
    const target = path.resolve(tmpDir);
    if (!target.startsWith(base) || !path.basename(target).startsWith("vozlibre-")) {
      return { ok: false, error: "Ruta temporal no reconocida." };
    }
    audio.cleanup(target);
    return { ok: true };
  });

  // ¿Está ffmpeg? El renderer lo usa para avisar antes de que falle.
  ipcMain.handle("audio:ffmpeg-status", () => ({
    available: audio.isAvailable(),
    hint: audio.INSTALL_HINT,
  }));

  // ---- Captura del audio del sistema (grabar reuniones) ----
  // Cuando el renderer llama a getDisplayMedia, Electron pregunta acá qué entregar.
  // Se responde con audio "loopback": lo que la PC REPRODUCE (Teams, Zoom, Meet…),
  // que es la pista de "los demás".
  //
  // Se entrega también una fuente de video porque Windows no da el loopback sin
  // ella; el renderer descarta el video apenas llega (ver meeting.js:abrirSistema).
  // Nada de la pantalla se graba ni sale de la máquina.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (!sources.length) return callback({});
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    // useSystemPicker false: elegimos la pantalla nosotros, sin diálogo de Windows.
    // El usuario ya decidió al tocar "grabar reunión"; un selector más sería ruido.
    { useSystemPicker: false }
  );

  // ---- Formateo a Markdown (Claude CLI) ----
  // Whisper devuelve texto corrido; esto lo convierte en Markdown legible. Corre en
  // el main porque necesita spawn de un proceso (el renderer no puede).
  ipcMain.handle("format:status", () => ({
    available: format.isAvailable(),
    hint: format.INSTALL_HINT,
  }));

  // Re-chequea el CLI (por si lo instalaste con VozLibre abierto).
  ipcMain.handle("format:recheck", () => {
    format.resetCliCache();
    return { available: format.isAvailable(), hint: format.INSTALL_HINT };
  });

  ipcMain.handle("format:transcript", async (e, payload) => {
    const parts = Array.isArray(payload?.parts) ? payload.parts : [];
    if (!parts.length) return { ok: false, error: "No hay texto para formatear." };

    const send = (payload2) => {
      if (!e.sender.isDestroyed()) e.sender.send("format:progress", payload2);
    };
    return format.formatTranscript(parts, {
      language: payload.language || "",
      showTimestamps: !!payload.showTimestamps,
      silences: Array.isArray(payload.silences) ? payload.silences : [],
      onProgress: (i, total) => send({ index: i, total }),
    });
  });

  // ---- Historial de transcripciones de archivo ----
  ipcMain.handle("history:save", (_e, payload) => {
    const cfg = settings.load();
    return history.save({
      folder: cfg.historyFolder || history.defaultFolder(),
      // "meeting" -> subcarpeta Reuniones/; cualquier otra cosa -> raíz.
      kind: payload?.kind === "meeting" ? "meeting" : "file",
      sourceName: payload?.sourceName || "",
      duration: payload?.duration || 0,
      language: payload?.language || "",
      text: payload?.text || "",
      formatted: !!payload?.formatted,
      partial: !!payload?.partial,
      failedCount: payload?.failedCount || 0,
      formatError: payload?.formatError || "",
    });
  });

  ipcMain.handle("history:list", () => ({ ok: true, entries: history.list() }));
  ipcMain.handle("history:read", (_e, id) => history.read(id));
  ipcMain.handle("history:remove", (_e, id, alsoFile) => history.remove(id, !!alsoFile));

  // Abre el .md (o su carpeta) con la app por defecto del sistema.
  ipcMain.handle("history:open", async (_e, id) => {
    const entry = history.list().find((x) => x.id === id);
    if (!entry) return { ok: false, error: "Entrada no encontrada." };
    if (entry.missing) return { ok: false, error: `El archivo ya no está en ${entry.path}` };
    const err = await shell.openPath(entry.path);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle("history:reveal", (_e, id) => {
    const entry = history.list().find((x) => x.id === id);
    if (!entry) return { ok: false, error: "Entrada no encontrada." };
    shell.showItemInFolder(entry.path);
    return { ok: true };
  });

  // Carpeta donde se guardan los .md: la elige el usuario con un diálogo nativo.
  ipcMain.handle("history:folder", () => ({
    ok: true,
    folder: settings.load().historyFolder || history.defaultFolder(),
    isDefault: !settings.load().historyFolder,
  }));

  // Abre en el explorador la carpeta donde se guardan los .md.
  ipcMain.handle("history:open-folder", async () => {
    const folder = settings.load().historyFolder || history.defaultFolder();
    try {
      fs.mkdirSync(folder, { recursive: true }); // puede no existir si nunca guardaste
    } catch (e) {
      return { ok: false, error: `No se pudo abrir la carpeta: ${e.message}` };
    }
    const err = await shell.openPath(folder);
    return err ? { ok: false, error: err } : { ok: true, folder };
  });

  ipcMain.handle("history:pick-folder", async () => {
    const win = windowMod.get();
    const wasFocusable = win ? win.isFocusable() : true;
    if (win && !wasFocusable) windowMod.setFocusable(true);
    hotkeys.disable();
    try {
      const res = await dialog.showOpenDialog(win, {
        title: "Elegí dónde guardar las transcripciones (.md)",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: settings.load().historyFolder || history.defaultFolder(),
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, folder: res.filePaths[0] };
    } finally {
      if (win && !wasFocusable) windowMod.setFocusable(false);
      // La config está abierta cuando se elige carpeta, así que los atajos siguen
      // desactivados a propósito: los re-activa el cierre de la config.
      if (!wasFocusable) hotkeys.register(settings.load());
    }
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
