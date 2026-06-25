/* VozLibre2 — Settings (persistencia de configuración)
 * ====================================================
 * Guarda/carga la config en un settings.json. Por ahora vive JUNTO AL EJECUTABLE
 * (en dev = raíz del proyecto). Encapsulado para que migrar a userData sea trivial:
 * solo hay que cambiar settingsPath().
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

// Valores por defecto. La API key vacía -> el usuario la pone desde la config.
const DEFAULTS = {
  groqApiKey: "",
  lang: "es",            // idioma del audio ("" = autodetectar)
  deviceId: "",          // micrófono elegido ("" = el por defecto del sistema)
  action: "show",        // qué hacer con el texto: "show" | "paste" | "type"
  shortcut: "Control+Shift+Space",  // atajo: grabar en el idioma de abajo
  shortcutTranslate: "Control+Shift+E", // atajo: grabar y traducir a inglés
};

function settingsPath() {
  // "Junto al exe": en producción, la carpeta del ejecutable; en dev, la raíz del
  // proyecto (un nivel arriba de src/).
  const base = app.isPackaged
    ? path.dirname(app.getPath("exe"))
    : path.join(__dirname, "..");
  return path.join(base, "settings.json");
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
