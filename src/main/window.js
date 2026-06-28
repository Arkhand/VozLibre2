/* VozLibre2 — Ventana píldora (UI nativa)
 * ========================================
 * Crea y gestiona la ventana flotante: frameless + transparent + alwaysOnTop
 * ("screen-saver") + skipTaskbar. NO roba el foco (focusable=false), salvo cuando se
 * abre la config (para poder escribir). El renderer mide su alto y pide el resize.
 */

const { BrowserWindow, screen } = require("electron");
const path = require("path");

const PILL_W = 380;
const PILL_H = 64;
const MAX_H = 560;

let win = null;

function create() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.max(0, screenW - PILL_W - 24);
  const y = 24;

  win = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      // El módulo vive en src/main/; preload e index.html están en src/ y src/renderer/.
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.setMenu(null);

  // CLAVE: la píldora NO debe robar el foco a tu app. Si lo robara, al teclear/pegar
  // el "campo activo" sería la píldora y no escribiría en tu app. Con focusable=false
  // la ventana NO toma foco pero SIGUE recibiendo clics en Windows. Solo la hacemos
  // focusable temporalmente al abrir la config (para escribir).
  win.setFocusable(false);

  // Mostrar SIN activar (no roba foco a la app que estés usando).
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => { win = null; });
  return win;
}

function get() { return win; }

// Foco on/off (para que la config pueda recibir tecleo).
function setFocusable(on) {
  if (!win) return;
  win.setFocusable(!!on);
  if (on) { win.show(); win.focus(); }
}

// El renderer mide el alto real de su contenido y nos pide ese alto. Ancho fijo;
// solo crece/encoge en vertical, entre PILL_H y MAX_H.
function resizeTo(contentHeight) {
  if (!win) return;
  const h = Math.min(MAX_H, Math.max(PILL_H, Math.round(contentHeight)));
  const [w] = win.getSize();
  if (h === win.getSize()[1]) return;
  win.setSize(w, h, false);
}

// Traer al frente (segunda instancia / clic en el tray). Mostrar SIN activar:
// la píldora no debe robar el foco a la app que estés usando.
function reveal() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.showInactive();
}

// Ocultar al tray (la ✕ ya no cierra la app, solo esconde la ventana).
function hide() {
  if (win) win.hide();
}

// ¿Está visible ahora mismo? (para alternar mostrar/ocultar desde el tray).
function isVisible() {
  return !!win && win.isVisible();
}

module.exports = { create, get, setFocusable, resizeTo, reveal, hide, isVisible };
