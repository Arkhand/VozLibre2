/* VozLibre2 — IPC (pegamento entre el renderer y los módulos del main)
 * ====================================================================
 * Registra todos los ipcMain handlers/listeners y conecta los módulos:
 * window (ventana), settings (config), hotkeys (atajos), typing (pegar/teclear).
 * Se llama una vez desde main.js (registerIpc).
 */

const { ipcMain, clipboard } = require("electron");
const settings = require("./settings");
const hotkeys = require("./hotkeys");
const typing = require("./typing");
const windowMod = require("./window");

function registerIpc() {
  // ---- Ventana ----
  // La ✕ ya NO cierra la app: oculta la píldora al tray. Para salir de verdad,
  // usar "Salir" en el menú del icono de la bandeja.
  ipcMain.on("pill:close", () => { windowMod.hide(); });
  ipcMain.on("pill:resize", (_e, height) => windowMod.resizeTo(height));

  // ---- Config (settings) ----
  ipcMain.handle("settings:load", () => settings.load());
  ipcMain.handle("settings:save", (_e, partial) => {
    const next = settings.save(partial);
    // Si cambió algún atajo, re-registrar ambos en el hook.
    const touchedShortcut = partial && (
      Object.prototype.hasOwnProperty.call(partial, "shortcut") ||
      Object.prototype.hasOwnProperty.call(partial, "shortcutTranslate")
    );
    if (touchedShortcut) hotkeys.register(next);
    return next;
  });

  // ---- Acciones de texto (pegar / teclear / portapapeles) ----
  ipcMain.handle("text:paste", (_e, text) => typing.pasteText(text));
  ipcMain.handle("text:type", (_e, text) => typing.typeText(text));
  ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(text); return { ok: true }; });

  // Config abierta: la píldora toma foco (para escribir) Y se DESACTIVAN los atajos
  // (si no, al asignar un atajo presionando la combinación se dispararía la grabación).
  // Al cerrar, se re-registran.
  ipcMain.on("pill:focusable", (_e, on) => {
    windowMod.setFocusable(on);
    if (on) hotkeys.disable();
    else hotkeys.register(settings.load());
  });

  // ---- Atajos ----
  ipcMain.handle("shortcut:register", () => hotkeys.register(settings.load()));
  ipcMain.handle("shortcut:capture", () => hotkeys.capture());

  // ---- Modo prueba: dispara la acción con texto fijo, sin gastar API ----
  // Da 1.5 s para que pongas el foco en tu app destino (Notepad/Word/VDI).
  ipcMain.handle("test:action", async (_e, action) => {
    const sample = "Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123";
    await new Promise((r) => setTimeout(r, 1500));
    if (action === "paste") return typing.pasteText(sample);
    return typing.typeText(sample);
  });
}

module.exports = { registerIpc };
