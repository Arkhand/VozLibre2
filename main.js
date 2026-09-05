/* VozLibre2 — Entry point del proceso principal
 * ==============================================
 * Píldora flotante minimalista para transcripción de voz (Groq Whisper).
 * Este archivo es solo el ORQUESTADOR: arma el ciclo de vida de Electron y conecta
 * los módulos. Cada responsabilidad vive en su propio archivo bajo src/main/:
 *   - window.js    → ventana píldora (frameless, transparent, alwaysOnTop, resize).
 *   - hotkeys.js   → atajos globales push-to-talk (uiohook, por keycode físico).
 *   - typing.js    → entregar el texto: pegar (Ctrl+V) / teclear (Unicode).
 *   - settings.js  → persistencia de la config (settings.json en userData).
 *   - ipc.js       → registro de handlers IPC que pegan todo lo anterior.
 * La grabación y la llamada a la API de Groq viven en el RENDERER (src/renderer/).
 */

const { app, BrowserWindow } = require("electron");
const log = require("./src/main/log");
const windowMod = require("./src/main/window");
const tray = require("./src/main/tray");
const hotkeys = require("./src/main/hotkeys");
const settings = require("./src/main/settings");
const format = require("./src/main/format");
const audio = require("./src/main/audio");
const autostart = require("./src/main/autostart");
const { registerIpc } = require("./src/main/ipc");

// Una sola instancia (evita dos píldoras flotando a la vez).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => windowMod.reveal());

app.whenReady().then(() => {
  // Log a archivo desde el primer momento: en el .exe no hay consola.
  log.init();
  console.log(`VozLibre ${app.getVersion()} — Electron ${process.versions.electron}, ` +
    `${process.platform} ${process.arch}, ${app.isPackaged ? "empaquetada" : "dev"}`);

  // Primera vez: el formateo a Markdown queda PRENDIDO si Claude Code está
  // instalado, apagado si no. Después manda lo que el usuario haya elegido.
  settings.resolveFormatDefault(format.isAvailable());
  console.log(`claude CLI: ${format.isAvailable() ? "sí" : "no"} · ffmpeg: ${audio.isAvailable() ? "sí" : "no"}`);

  registerIpc();
  windowMod.create();
  // Icono de bandeja: la ✕ oculta la píldora acá; "Salir" cierra de verdad.
  tray.create();

  // Los hotkeys necesitan saber cuál es la ventana actual para enviarle los eventos.
  hotkeys.init(() => windowMod.get());
  // Registrar los atajos guardados al arrancar. Si el hook no carga, el renderer
  // lo pregunta (shortcut:status) y lo muestra: un fallo silencioso acá se ve
  // como "los atajos no andan" sin ninguna pista.
  const hk = hotkeys.register(settings.load());
  console.log(`atajos: ${hk.ok ? "ok" : "FALLO: " + hk.error}`);

  // Re-aplicar "iniciar con Windows" con la ruta actual del .exe (por si lo movieron).
  autostart.apply(settings.load());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windowMod.create();
  });
});

app.on("will-quit", () => { hotkeys.stop(); tray.destroy(); });
// La ✕ oculta la ventana (no la cierra), así que normalmente esto no salta. Como la
// app vive en el tray, no salimos al "cerrar todas las ventanas": solo "Salir" cierra.
