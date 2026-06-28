/* VozLibre2 — Pegado (Ctrl+V) y simulación de teclado
 * ====================================================
 * Entrega el texto reconocido a la app que tenga el foco. Tres mecanismos:
 *   - pasteText(): copia al portapapeles y simula Ctrl+V (nut.js). Rápido, pero el
 *     portapapeles puede estar bloqueado en VDI/RDP.
 *   - typeText():  inyecta cada carácter como pulsación Unicode real vía SendInput
 *     (PowerShell, type-unicode.ps1). Soporta acentos/ñ/¿¡ y funciona en VDI/RDP,
 *     sin tocar el portapapeles. Es el modo "type" de la config.
 * La píldora NO roba el foco, así que el tecleo cae en la app del usuario.
 */

const { app, clipboard } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

// nut.js (teclado nativo). Carga perezosa: no penaliza el arranque y un fallo de la
// lib nativa no impide abrir la píldora (solo deshabilita el tecleo).
let nut = null;
function getNut() {
  if (nut) return nut;
  try {
    const { keyboard, Key } = require("@nut-tree-fork/nut-js");
    // 0 ms pierde caracteres en apps que tardan en aceptar foco (VMs/RDP). 6 ms es
    // imperceptible y fiable.
    keyboard.config.autoDelayMs = 6;
    nut = { keyboard, Key };
  } catch (err) {
    console.error(`[nut] no disponible: ${err.message}`);
    nut = { keyboard: null, Key: null };
  }
  return nut;
}

// Pegar: copiar al portapapeles + Ctrl+V en la app activa.
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
// A diferencia de nut.js (que se come acentos) y del Ctrl+V (portapapeles, bloqueado
// en VDI/RDP), inyecta cada carácter Unicode como evento de teclado genuino:
// soporta acentos y funciona en VDI/RDP. Invisible (windowsHide). El texto va por
// STDIN en UTF-8 (evita problemas de escaping/longitud).
function typeText(text) {
  if (process.platform !== "win32") {
    // Fallback no-Windows: nut.js (sin soporte Unicode garantizado).
    const { keyboard } = getNut();
    if (!keyboard) return Promise.resolve({ ok: false, error: "tecleo no disponible" });
    return keyboard.type(text).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }));
  }
  // type-unicode.ps1: en dev vive en src/ (un nivel arriba de src/main/); empaquetado,
  // se copia a resources (ver extraResources en package.json).
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, "type-unicode.ps1")
    : path.join(__dirname, "..", "type-unicode.ps1");

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
    ps.stdin.write(Buffer.from(text, "utf8"));
    ps.stdin.end();
  });
}

module.exports = { pasteText, typeText };
