/* VozLibre2 — Gestión de la configuración
 * ========================================
 * Carga y guarda la config del usuario en settings.json dentro de userData
 * (Windows: %APPDATA%\VozLibre2\settings.json). Ruta FIJA y persistente, válida en
 * dev y empaquetado: imprescindible para el .exe portable, que se auto-extrae a una
 * carpeta temporal distinta en cada ejecución (guardar "junto al exe" perdería la
 * config —API key, idioma, atajos— cada vez).
 *
 * Formato de los atajos: objeto uiohook { keycode, ctrl, shift, alt, meta }. El
 * keycode es la tecla FÍSICA (no el carácter), así funciona con cualquier layout.
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

// Valores por defecto. La API key vacía -> el usuario la pone desde la config.
// Atajos por defecto: F8 dictar, F9 traducir (teclas dedicadas, sin Shift, sin
// choques). Se re-asignan desde el panel de config (captura nativa).
const DEFAULTS = {
  groqApiKey: "",
  lang: "es",            // idioma del audio ("" = autodetectar)
  deviceId: "",          // micrófono elegido ("" = el por defecto del sistema)
  action: "show",        // qué hacer con el texto: "show" | "paste" | "type"
  shortcut: { keycode: 66, ctrl: false, shift: false, alt: false, meta: false },          // F8: dictar
  shortcutTranslate: { keycode: 67, ctrl: false, shift: false, alt: false, meta: false }, // F9: traducir
};

function settingsPath() {
  // userData: ruta por-usuario fija y persistente que Electron crea/gestiona
  // (Windows: %APPDATA%\VozLibre2). No depende de dónde corra el exe.
  return path.join(app.getPath("userData"), "settings.json");
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const data = JSON.parse(raw);
    // Mezclar con defaults para tolerar settings.json viejos/incompletos.
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    console.error(`[settings] no se pudo guardar: ${err.message}`);
  }
  return next;
}

module.exports = { load, save, settingsPath, DEFAULTS };
