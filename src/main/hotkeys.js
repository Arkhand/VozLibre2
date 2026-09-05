/* VozLibre2 — Detección de hotkeys globales (push-to-talk)
 * ========================================================
 * Atajos globales para grabar desde CUALQUIER app, con uiohook-napi (hook de teclado
 * nativo, en proceso). Trabaja por KEYCODE FÍSICO (no por carácter), así funciona con
 * cualquier tecla/símbolo/layout, y da keydown Y keyup nativos (push-to-talk real:
 * mantener = grabar, soltar = parar — el globalShortcut de Electron no ve el keyup).
 *
 * Dos atajos, cada uno con su "modo":
 *   - transcribe: graba en el idioma de la config.
 *   - translate:  graba y traduce a inglés.
 * Un solo listener evalúa cada evento; al coincidir emite al renderer (via la window
 * que se pasa en init):  pill:ptt-down / pill:ptt-up  con el modo.
 *
 * Formato del atajo (en settings): { keycode:<n>, ctrl, shift, alt, meta }.
 * Captura: capture() arranca el "modo aprender" y resuelve con el bind de la próxima
 * tecla real (para que la config asigne atajos presionándolos).
 */

const { t } = require("../i18n/i18n");

let uIOhook = null;       // instancia de uiohook (carga perezosa)
let uioStarted = false;
let lastError = "";       // por qué no cargó/arrancó el hook (para mostrarlo)
let lastStatus = null;    // último resultado de register(), para que el renderer lo pida
let enabled = true;       // se desactiva mientras la config está abierta
let captureCb = null;     // si !=null, el próximo keydown se "captura" para la config
let getWin = () => null;  // provista por init(): devuelve la BrowserWindow actual

const binds = { transcribe: null, translate: null };     // atajos activos
// Un solo push-to-talk activo a la vez. Guarda el MODO con el que arrancó la grabación
// y la KEYCODE de la tecla principal que hay que soltar para terminar. Esto evita que,
// cuando ambos atajos comparten la tecla y se diferencian por un modificador (p.ej.
// inglés = español + Ctrl), soltar ese modificador antes que la tecla cambie el modo:
// el autorepeat del teclado emitiría keydown que matchean el OTRO atajo. Mientras hay
// un PTT activo ignoramos cualquier otro down, y al soltar la tecla principal cerramos
// con el modo original (lo que dice el título), sin importar los modificadores.
let active = null;   // { mode, keycode } o null

// Keycodes uiohook de modificadores (L+R) — se ignoran al capturar (esperamos una
// tecla "real", no un modificador suelto).
const MOD_KEYCODES = new Set([29, 42, 54, 56, 3613, 3675, 3676, 97, 100]);

function getUio() {
  if (uIOhook) return uIOhook;
  try {
    ({ uIOhook } = require("uiohook-napi"));
    lastError = "";
  } catch (err) {
    console.error(`[uiohook] no disponible: ${err.message}`);
    lastError = t("no se pudo cargar el hook de teclado (uiohook): {msg}", { msg: err.message });
    uIOhook = null;
  }
  return uIOhook;
}

// ¿El evento de teclado coincide con el bind? Compara keycode físico + modificadores
// EXACTOS. uiohook ya entrega ctrl/shift/alt/meta del evento, sin líos de layout.
function matches(bind, e) {
  if (!bind || typeof bind.keycode !== "number") return false;
  return e.keycode === bind.keycode &&
    !!bind.ctrl === !!e.ctrlKey &&
    !!bind.shift === !!e.shiftKey &&
    !!bind.alt === !!e.altKey &&
    !!bind.meta === !!e.metaKey;
}

function onKeydown(e) {
  // Modo "capturar atajo" (config): devolvemos la tecla y no disparamos PTT.
  if (captureCb) {
    if (!MOD_KEYCODES.has(e.keycode)) {
      const cb = captureCb; captureCb = null;
      cb({ keycode: e.keycode, ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey });
    }
    return;
  }
  const win = getWin();
  if (!enabled || !win) return;
  // Ya hay una grabación PTT en curso: ignorar todo down (incluido el autorepeat de la
  // tecla mantenida). No empezamos otra ni cambiamos de modo a mitad de camino.
  if (active) return;
  // El atajo MÁS específico gana: probamos translate (suele llevar un modificador extra
  // sobre transcribe) antes que transcribe, para no quedarnos con el de menos teclas.
  for (const mode of ["translate", "transcribe"]) {
    if (matches(binds[mode], e)) {
      active = { mode, keycode: e.keycode };
      // Si la píldora está oculta en el tray, mostrarla para ver el feedback de
      // grabación (sin robar el foco a la app activa).
      if (!win.isVisible()) win.showInactive();
      win.webContents.send("pill:ptt-down", mode);
      return;
    }
  }
}

function onKeyup(e) {
  const win = getWin();
  if (!win) return;
  // Terminamos SOLO al soltar la tecla principal con la que arrancó la grabación.
  // Cerramos con el modo original (el del título), ignorando los modificadores: así,
  // soltar el Control antes que la tecla no cambia inglés→español.
  if (active && e.keycode === active.keycode) {
    const mode = active.mode;
    active = null;
    win.webContents.send("pill:ptt-up", mode);
  }
}

function ensureRunning() {
  const u = getUio();
  if (!u) return false;
  if (!uioStarted) {
    u.on("keydown", onKeydown);
    u.on("keyup", onKeyup);
    try { u.start(); uioStarted = true; lastError = ""; }
    catch (err) {
      console.error(`[uiohook] start falló: ${err.message}`);
      lastError = t("el hook de teclado no pudo arrancar: {msg}", { msg: err.message });
      return false;
    }
  }
  return true;
}

// Normaliza un atajo de settings a {keycode,ctrl,shift,alt,meta} o null.
// Acepta el formato nuevo (objeto). Strings viejos ("Super+/") -> null (re-capturar).
function normalizeBind(val) {
  if (val && typeof val === "object" && typeof val.keycode === "number") {
    return { keycode: val.keycode, ctrl: !!val.ctrl, shift: !!val.shift, alt: !!val.alt, meta: !!val.meta };
  }
  return null;
}

// ---- API pública ----

// init(fn): fn() debe devolver la BrowserWindow actual (o null). Se llama una vez.
function init(winGetter) { getWin = winGetter; }

// Registra ambos atajos desde el objeto settings y arranca/reactiva el hook.
function register(cfg) {
  binds.transcribe = normalizeBind(cfg.shortcut);
  binds.translate = normalizeBind(cfg.shortcutTranslate);
  enabled = true;
  const ok = ensureRunning();
  lastStatus = { ok, error: ok ? "" : (lastError || t("motivo desconocido")), transcribe: { ok: !!binds.transcribe }, translate: { ok: !!binds.translate } };
  return lastStatus;
}

// Último resultado de register() (o un intento fresco si nunca se registró).
function getStatus() {
  return lastStatus || { ok: false, error: t("todavía no se registraron los atajos"), transcribe: { ok: false }, translate: { ok: false } };
}

// Desactiva la detección PTT (sin parar el hook). Usar al abrir la config, para que
// asignar un atajo no dispare la grabación.
function disable() {
  enabled = false;
  active = null;
}

// Captura nativa: resuelve con el bind {keycode,...} de la próxima tecla real.
// Timeout 8s. Desactiva PTT mientras captura.
function capture() {
  if (!ensureRunning()) return Promise.resolve({ ok: false, error: t("uiohook no disponible") });
  enabled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { captureCb = null; resolve({ ok: false, error: "timeout" }); }, 8000);
    captureCb = (bind) => { clearTimeout(timer); resolve({ ok: true, bind }); };
  });
}

// Parar el hook del todo (al cerrar la app).
function stop() {
  if (uIOhook && uioStarted) { try { uIOhook.stop(); } catch {} uioStarted = false; }
}

module.exports = { init, register, disable, capture, stop, getStatus };
