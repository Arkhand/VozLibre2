/* VozLibre2 — Proceso principal de Electron
 * ==========================================
 * Pildora flotante minimalista para transcripcion de voz (Groq Whisper).
 *   - Ventana NATIVA frameless + transparent + alwaysOnTop ("screen-saver") +
 *     skipTaskbar. En reposo es COMPACTA (orbe + engranaje + cruz); al transcribir
 *     o abrir config se EXPANDE (el renderer mide el alto y lo pide via IPC).
 *   - Persistencia: src/settings.js (settings.json junto al exe).
 *   - Acciones post-texto: mostrar / pegar (Ctrl+V, nut.js) / teclear (SendInput
 *     Unicode vía PowerShell: soporta acentos y funciona en VDI/RDP, sin clipboard).
 *   - Atajo GLOBAL configurable PUSH-TO-TALK (hook de teclado src/keyhook.ps1):
 *     mantener presionado = grabar, soltar = transcribir, desde cualquier app.
 */

const { app, BrowserWindow, ipcMain, screen, clipboard } = require("electron");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const settings = require("./src/settings");

// Una sola instancia (evita dos pildoras flotando a la vez).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// nut.js (teclado/portapapeles nativo). Carga perezosa para no penalizar el
// arranque y para que un fallo de la lib nativa no impida abrir la pildora.
let nut = null;
function getNut() {
  if (nut) return nut;
  try {
    const { keyboard, Key } = require("@nut-tree-fork/nut-js");
    // Pequeño delay entre teclas: 0 pierde caracteres en algunas apps (VMs/RDP,
    // apps que tardan en aceptar foco). 6ms es imperceptible y fiable.
    keyboard.config.autoDelayMs = 6;
    nut = { keyboard, Key };
  } catch (err) {
    console.error(`[nut] no disponible: ${err.message}`);
    nut = { keyboard: null, Key: null };
  }
  return nut;
}

const PILL_W = 380;
const PILL_H = 64;
const MAX_H = 560;

let win = null;
let currentShortcut = null;

// ---------------------------------------------------------------------------
// Ventana pildora
// ---------------------------------------------------------------------------
function createWindow() {
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
      preload: path.join(__dirname, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "src", "renderer", "index.html"));
  win.setMenu(null);

  // CLAVE: la pildora NO debe robar el foco a tu app. Si lo robara, al teclear/
  // pegar el "campo activo" sería la pildora y no escribiría en tu app. Con
  // focusable=false la ventana NO toma foco pero SIGUE recibiendo clics en Windows.
  // Solo la hacemos focusable temporalmente al abrir la config (para escribir).
  win.setFocusable(false);

  // Mostrar SIN activar (no roba foco a la app que estés usando).
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => { win = null; });
}

// Hacer la pildora focusable o no (para que la config pueda recibir tecleo).
function setFocusable(on) {
  if (!win) return;
  win.setFocusable(!!on);
  if (on) { win.show(); win.focus(); }
}

// El renderer mide el alto real de su contenido y nos pide ese alto.
function resizeTo(contentHeight) {
  if (!win) return;
  const h = Math.min(MAX_H, Math.max(PILL_H, Math.round(contentHeight)));
  const [w] = win.getSize();
  if (h === win.getSize()[1]) return;
  win.setSize(w, h, false);
}

// ---------------------------------------------------------------------------
// Atajo global PUSH-TO-TALK (grabar desde cualquier app mientras se MANTIENE
// presionado). Usa un hook de teclado de bajo nivel (src/keyhook.ps1) porque el
// globalShortcut de Electron NO detecta el keyup. El hook imprime DOWN/UP por
// stdout; aquí se traduce a pill:ptt-down / pill:ptt-up para la pildora.
// ---------------------------------------------------------------------------
let hookProc = null;

// "Control+Shift+Space" -> { key:"Space", ctrl, shift, alt, win } para el hook.
function parseAccelerator(accel) {
  const parts = String(accel).split("+").map((p) => p.trim()).filter(Boolean);
  const r = { key: "Space", ctrl: false, shift: false, alt: false, win: false };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "control" || low === "ctrl" || low === "commandorcontrol") r.ctrl = true;
    else if (low === "shift") r.shift = true;
    else if (low === "alt") r.alt = true;
    else if (low === "super" || low === "meta" || low === "win" || low === "cmd") r.win = true;
    else r.key = p; // la tecla principal
  }
  return r;
}

function stopHook() {
  if (hookProc && hookProc.pid) {
    // taskkill /T mata el árbol (PowerShell + su hook) de forma fiable en Windows.
    try { execFileSync("taskkill", ["/PID", String(hookProc.pid), "/T", "/F"], { windowsHide: true }); }
    catch { try { hookProc.kill(); } catch {} }
  }
  hookProc = null;
}

function registerShortcut(accelerator) {
  stopHook();
  currentShortcut = accelerator || null;
  if (!accelerator) return { ok: true };

  const { key, ctrl, shift, alt, win: winMod } = parseAccelerator(accelerator);
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, "keyhook.ps1")
    : path.join(__dirname, "src", "keyhook.ps1");

  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Key", key];
  if (ctrl) args.push("-Ctrl");
  if (shift) args.push("-Shift");
  if (alt) args.push("-Alt");
  if (winMod) args.push("-Win");

  try {
    hookProc = spawn("powershell.exe", args, { windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let buf = "";
  hookProc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "DOWN" && win) win.webContents.send("pill:ptt-down");
      else if (line === "UP" && win) win.webContents.send("pill:ptt-up");
    }
  });
  hookProc.stderr.on("data", (d) => process.stderr.write(`[keyhook] ${d}`));
  hookProc.on("exit", () => { hookProc = null; });
  hookProc.on("error", () => { hookProc = null; });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Acciones post-texto: pegar (Ctrl+V) o teclear en la app activa (nut.js).
// La pildora no roba el foco (skipTaskbar + no activable al mostrar texto),
// asi que el foco sigue en la app del usuario.
// ---------------------------------------------------------------------------
async function pasteText(text) {
  const { keyboard, Key } = getNut();
  clipboard.writeText(text);
  if (!keyboard) return { ok: false, error: "nut.js no disponible" };
  try {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Teclear como PULSACIONES REALES vía SendInput/KEYEVENTF_UNICODE (PowerShell).
// A diferencia de nut.js (que se come acentos/ñ/¿¡) y del Ctrl+V (que usa el
// portapapeles, bloqueado en VDI/RDP), esto inyecta cada carácter Unicode como
// evento de teclado genuino: soporta acentos y funciona en VDI/RDP. Invisible
// (windowsHide, no roba foco). El texto va por STDIN en UTF-8.
function typeText(text) {
  if (process.platform !== "win32") {
    // Fallback no-Windows: nut.js (sin soporte Unicode garantizado).
    const { keyboard } = getNut();
    if (!keyboard) return Promise.resolve({ ok: false, error: "tecleo no disponible" });
    return keyboard.type(text).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }));
  }
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, "type-unicode.ps1")
    : path.join(__dirname, "src", "type-unicode.ps1");

  return new Promise((resolve) => {
    let ps;
    try {
      ps = spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      ], { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let err = "";
    ps.stderr.on("data", (d) => { err += d.toString(); });
    ps.on("error", (e) => resolve({ ok: false, error: e.message }));
    ps.on("exit", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `powershell exit ${code}` });
    });
    // Enviar el texto por STDIN en UTF-8 (evita problemas de escaping/longitud).
    ps.stdin.write(Buffer.from(text, "utf8"));
    ps.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on("pill:close", () => { app.quit(); });
ipcMain.on("pill:resize", (_e, height) => resizeTo(height));

ipcMain.handle("settings:load", () => settings.load());
ipcMain.handle("settings:save", (_e, partial) => {
  const next = settings.save(partial);
  // Si cambio el atajo, re-registrarlo.
  if (partial && Object.prototype.hasOwnProperty.call(partial, "shortcut")) {
    registerShortcut(next.shortcut);
  }
  return next;
});

ipcMain.handle("text:paste", (_e, text) => pasteText(text));
ipcMain.handle("text:type", (_e, text) => typeText(text));
ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(text); return { ok: true }; });

// La pildora pide foco solo mientras la config está abierta (para escribir).
ipcMain.on("pill:focusable", (_e, on) => setFocusable(on));

// MODO PRUEBA: dispara la acción ("paste"/"type") con texto fijo, sin gastar API.
// Da 1.5s para que pongas el foco en tu app destino (Notepad/Word/VDI).
ipcMain.handle("test:action", async (_e, action) => {
  const sample = "Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123";
  await new Promise((r) => setTimeout(r, 1500)); // tiempo para enfocar tu app
  if (action === "paste") return pasteText(sample);
  return typeText(sample);
});

ipcMain.handle("shortcut:register", (_e, accelerator) => registerShortcut(accelerator));

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  // Registrar el atajo guardado al arrancar.
  const cfg = settings.load();
  if (cfg.shortcut) registerShortcut(cfg.shortcut);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => { stopHook(); });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
