/* VozLibre2 — Pegado (Ctrl+V) y simulación de teclado
 * ====================================================
 * Entrega el texto reconocido a la app que tenga el foco. Dos mecanismos:
 *   - pasteText(): copia al portapapeles y simula Ctrl+V (nut.js). Rápido, pero el
 *     portapapeles puede estar bloqueado en VDI/RDP.
 *   - typeText():  inyecta cada carácter como pulsación Unicode real vía SendInput
 *     (Win32, llamado directo con koffi). Soporta acentos/ñ/¿¡ y funciona en
 *     VDI/RDP, sin tocar el portapapeles. Es el modo "type" de la config.
 * La píldora NO roba el foco, así que el tecleo cae en la app del usuario.
 *
 * Antes el tecleo lanzaba PowerShell con un script C# compilado al vuelo
 * (Add-Type): entre medio segundo y uno y medio de espera ANTES de la primera
 * letra, en cada dictado. Con koffi la llamada a user32!SendInput es directa y el
 * texto empieza a salir al instante.
 */

const { clipboard } = require("electron");
const { t } = require("../i18n/i18n");

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
  if (!keyboard) return { ok: false, error: t("nut.js no disponible") };
  try {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// SendInput / KEYEVENTF_UNICODE vía koffi (solo Windows)
// ---------------------------------------------------------------------------
// Pausa antes de la primera tecla: la app destino puede estar terminando de tomar
// el foco (el atajo se acaba de soltar). Y entre caracteres: 2 ms es fiable en apps
// lentas/VDI sin ser perceptible.
const FOCUS_SETTLE_MS = 150;
const PER_CHAR_DELAY_MS = 2;

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const VK_RETURN = 0x0d;

let win32 = null;   // { SendInput, INPUT } | { error }
function getWin32() {
  if (win32) return win32;
  try {
    const koffi = require("koffi");
    // CLAVE: el struct INPUT debe medir 40 bytes en x64 (4 type + 4 padding + 32
    // del union, que reserva el tamaño de MOUSEINPUT). Si no, SendInput devuelve 0
    // con ERROR_INVALID_PARAMETER y no teclea nada. Declarar el union completo (y
    // no solo KEYBDINPUT) es lo que garantiza ese tamaño.
    const KEYBDINPUT = koffi.struct("VL_KEYBDINPUT", {
      wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
    });
    const MOUSEINPUT = koffi.struct("VL_MOUSEINPUT", {
      dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
    });
    const HARDWAREINPUT = koffi.struct("VL_HARDWAREINPUT", {
      uMsg: "uint32", wParamL: "uint16", wParamH: "uint16",
    });
    const INPUT_UNION = koffi.union("VL_INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
    const INPUT = koffi.struct("VL_INPUT", { type: "uint32", u: INPUT_UNION });
    const user32 = koffi.load("user32.dll");
    const SendInput = user32.func("uint32 __stdcall SendInput(uint32 nInputs, VL_INPUT *pInputs, int cbSize)");
    win32 = { SendInput, size: koffi.sizeof(INPUT) };
  } catch (err) {
    console.error(`[typing] koffi/SendInput no disponible: ${err.message}`);
    win32 = { error: err.message };
  }
  return win32;
}

// Par keydown+keyup para un carácter Unicode (una unidad UTF-16: los emojis van
// como dos pares, igual que los teclearía Windows).
function unicodePair(code) {
  const ki = (flags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  return [ki(KEYEVENTF_UNICODE), ki(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)];
}

// Enter de verdad (tecla virtual): muchos controles ignoran un U+000A inyectado
// como carácter, pero todos entienden VK_RETURN.
function returnPair() {
  const ki = (flags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: VK_RETURN, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  return [ki(0), ki(KEYEVENTF_KEYUP)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Teclea el texto carácter por carácter con SendInput. Asíncrono con un respiro
// entre caracteres para no bloquear el proceso principal durante un texto largo.
async function sendUnicode(text) {
  const w = getWin32();
  if (w.error) return { ok: false, error: t("tecleo nativo no disponible: {msg}", { msg: w.error }) };

  await sleep(FOCUS_SETTLE_MS);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\r") continue;                 // \r\n -> un solo Enter
    const pair = ch === "\n" ? returnPair() : unicodePair(text.charCodeAt(i));
    const sent = w.SendInput(pair.length, pair, w.size);
    if (sent !== pair.length) {
      return { ok: false, error: t("SendInput rechazó el carácter {i} de {n}", { i: i + 1, n: text.length }) };
    }
    if (PER_CHAR_DELAY_MS > 0) await sleep(PER_CHAR_DELAY_MS);
  }
  return { ok: true };
}

// Teclear como PULSACIONES REALES. A diferencia de nut.js (que se come acentos) y
// del Ctrl+V (portapapeles, bloqueado en VDI/RDP), inyecta cada carácter Unicode
// como evento de teclado genuino: soporta acentos y funciona en VDI/RDP.
function typeText(text) {
  if (process.platform === "win32") return sendUnicode(String(text || ""));
  // Fallback no-Windows: nut.js (sin soporte Unicode garantizado).
  const { keyboard } = getNut();
  if (!keyboard) return Promise.resolve({ ok: false, error: t("tecleo no disponible") });
  return keyboard.type(text).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }));
}

module.exports = { pasteText, typeText };
