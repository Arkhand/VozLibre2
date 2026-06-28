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
const windowMod = require("./src/main/window");
const tray = require("./src/main/tray");
const hotkeys = require("./src/main/hotkeys");
const settings = require("./src/main/settings");
const { registerIpc } = require("./src/main/ipc");

// Una sola instancia (evita dos píldoras flotando a la vez).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => windowMod.reveal());

app.whenReady().then(() => {
  registerIpc();
  windowMod.create();
  // Icono de bandeja: la ✕ oculta la píldora acá; "Salir" cierra de verdad.
  tray.create();

  // Los hotkeys necesitan saber cuál es la ventana actual para enviarle los eventos.
  hotkeys.init(() => windowMod.get());
  // Registrar los atajos guardados al arrancar.
  hotkeys.register(settings.load());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windowMod.create();
  });
});

app.on("will-quit", () => { hotkeys.stop(); tray.destroy(); });
// La ✕ oculta la ventana (no la cierra), así que normalmente esto no salta. Como la
// app vive en el tray, no salimos al "cerrar todas las ventanas": solo "Salir" cierra.
