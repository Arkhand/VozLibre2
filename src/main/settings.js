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
  // Idioma del audio. "" = autodetectar (Whisper lo deduce del audio).
  // Ojo: fijar un idioma acá no solo "ayuda" a Whisper, le ORDENA la salida en ese
  // idioma: con lang="es" un audio en inglés vuelve TRADUCIDO al español. Por eso
  // el default es autodetectar, y el idioma fijo queda para quien lo necesite.
  lang: "",
  deviceId: "",          // micrófono elegido ("" = el por defecto del sistema)
  action: "show",        // qué hacer con el texto: "show" | "paste" | "type"
  shortcut: { keycode: 66, ctrl: false, shift: false, alt: false, meta: false },          // F8: dictar
  shortcutTranslate: { keycode: 67, ctrl: false, shift: false, alt: false, meta: false }, // F9: traducir
  // Duración máxima de cada trozo al partir un audio largo, en minutos.
  // 10 min es el recomendado: entra cómodo en el límite por pedido de Groq en
  // todos los tiers y deja los trozos bien por debajo de los 25 MB. Subirlo
  // manda menos pedidos (más rápido) pero arriesga rechazos de la API.
  chunkMinutes: 10,

  // ---- Formateo a Markdown (Claude CLI) ----
  // Pasa la transcripción cruda por `claude -p` para que salga con puntuación y
  // párrafos en vez de un bloque corrido. null = "no elegido todavía": al arrancar
  // se resuelve a true si el CLI está instalado (ver resolveFormatDefault).
  formatMarkdown: null,
  // Encabezados "### [mm:ss]" por tramo en los archivos largos. Solo aplica a
  // archivos partidos en varias partes: en un audio corto no hay tramos que marcar.
  formatTimestamps: true,

  // ---- Reuniones ----
  // Micrófono para la pista "Yo". "" = el mismo que usa el dictado (deviceId).
  // Se separa a propósito: en una reunión solés usar auriculares con micrófono, y
  // no tiene por qué ser el mismo con el que dictás.
  meetingMicId: "",
  // Confirmar antes de empezar a grabar (evita arrancar sin querer).
  meetingConfirm: true,

  // ---- Historial de archivos ----
  // Guardar un .md por cada archivo transcripto. No aplica al push-to-talk.
  saveHistory: true,
  // Carpeta destino de los .md. "" = Documentos\VozLibre (ver history.defaultFolder).
  historyFolder: "",
};

// Versión del esquema de settings. Sube cuando hay que migrar un settings.json
// viejo (ver migrate).
const SCHEMA_VERSION = 2;

function settingsPath() {
  // userData: ruta por-usuario fija y persistente que Electron crea/gestiona
  // (Windows: %APPDATA%\VozLibre2). No depende de dónde corra el exe.
  return path.join(app.getPath("userData"), "settings.json");
}

/* Adapta un settings.json viejo al esquema actual.
 *
 * v1 -> v2: el default de `lang` era "es" y se mandaba SIEMPRE a Whisper como
 * parámetro `language`, así que un audio en inglés volvía traducido al español sin
 * que nadie lo hubiera pedido. Quien tenga "es" guardado lo tiene porque era el
 * default, no porque lo eligiera: pasa a "" (autodetectar). Un idioma elegido a
 * mano (cualquier otro) se respeta.
 */
function migrate(data) {
  const from = typeof data.schemaVersion === "number" ? data.schemaVersion : 1;
  if (from >= SCHEMA_VERSION) return data;

  const next = { ...data };
  if (from < 2 && next.lang === "es") next.lang = "";
  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const data = migrate(JSON.parse(raw));
    // Mezclar con defaults para tolerar settings.json viejos/incompletos.
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS, schemaVersion: SCHEMA_VERSION };
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

/* Resuelve el default de formatMarkdown la primera vez: prendido si Claude CLI
 * está instalado, apagado si no. Se llama una vez al arrancar (main.js).
 *
 * Queda persistido para que la decisión no cambie sola: si el usuario lo apagó a
 * mano, instalar/desinstalar el CLI después no debe volver a prenderlo. Solo el
 * valor null (nunca resuelto) se toca acá.
 */
function resolveFormatDefault(cliAvailable) {
  const current = load();
  if (current.formatMarkdown !== null && current.formatMarkdown !== undefined) return current;
  return save({ formatMarkdown: !!cliAvailable });
}

module.exports = { load, save, settingsPath, resolveFormatDefault, DEFAULTS, SCHEMA_VERSION };
