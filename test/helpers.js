/* Helpers de test
 * ===============
 * Los módulos del renderer son IIFEs que se cuelgan de `window` (no hacen
 * module.exports, por contextIsolation). Para probarlos en Node se les da un
 * `window` global con lo mínimo que esperan al cargarse: el i18n (VLI18n).
 */
const path = require("path");

function ensureWindow() {
  if (!global.window) global.window = {};
  if (!global.window.VLI18n) {
    global.window.VLI18n = require(path.join(__dirname, "..", "src", "i18n", "i18n.js"));
  }
  return global.window;
}

function loadRendererModule(file, globalName) {
  const win = ensureWindow();
  // Las APIs de navegador (navigator, MediaRecorder…) solo se usan dentro de
  // funciones, así que cargar el módulo no las necesita.
  require(path.join(__dirname, "..", "src", "renderer", file));
  return win[globalName];
}

module.exports = { loadRendererModule, ensureWindow };
