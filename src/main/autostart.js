/* VozLibre2 — Iniciar con Windows
 * ================================
 * Registra (o quita) la app en el inicio de sesión de Windows con la API de
 * Electron (queda en HKCU\...\Run, sin instalador).
 *
 * OJO con el portable: el .exe se auto-extrae a %TEMP% y process.execPath apunta
 * AHÍ, a una carpeta que desaparece. electron-builder deja la ruta del .exe real
 * en PORTABLE_EXECUTABLE_FILE; esa es la que hay que registrar. Se re-aplica en
 * cada arranque para que, si movés el .exe, la entrada apunte al nuevo lugar.
 *
 * En desarrollo (sin empaquetar) no se toca nada: registraría electron.exe.
 */

const { app } = require("electron");

function exePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function supported() {
  return process.platform === "win32" && app.isPackaged;
}

function apply(cfg) {
  if (!supported()) return { ok: false, unsupported: true };
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.startWithWindows, path: exePath(), args: [] });
    return { ok: true, enabled: !!cfg.startWithWindows, path: exePath() };
  } catch (e) {
    console.error(`[autostart] no se pudo aplicar: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function status() {
  if (!supported()) return { supported: false, enabled: false };
  try {
    return { supported: true, enabled: !!app.getLoginItemSettings({ path: exePath() }).openAtLogin };
  } catch {
    return { supported: true, enabled: false };
  }
}

module.exports = { apply, status, supported, exePath };
