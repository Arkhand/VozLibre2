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

const { app, safeStorage } = require("electron");
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
  // Modelo de Whisper en Groq para TRANSCRIBIR (ver MODELS). Traducir usa siempre
  // whisper-large-v3: es el único que soporta /audio/translations.
  model: "whisper-large-v3-turbo",
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

  // ---- Sistema ----
  // Registrar la app en el inicio de sesión de Windows (ver autostart.js).
  startWithWindows: false,
  // Idioma de la interfaz (ver src/i18n). Por ahora solo "es".
  uiLang: "es",

  // ---- Avisos de arranque (se muestran hasta que el usuario los cierre) ----
  // "No avisar más" del aviso de ffmpeg ausente.
  ffmpegNoticeDismissed: false,
  // El aviso de que el formateo usa Claude CLI se muestra UNA vez.
  claudeNoticeShown: false,
};

// Modelos de transcripción disponibles en Groq. Se valida contra esta lista para
// que un settings.json editado a mano no mande un modelo inexistente a la API.
const MODELS = [
  { id: "whisper-large-v3-turbo", label: "Whisper large-v3 turbo (rápido, recomendado)" },
  { id: "whisper-large-v3", label: "Whisper large-v3 (más preciso, más lento)" },
];
const MODEL_IDS = MODELS.map((m) => m.id);

// Versión del esquema de settings. Sube cuando hay que migrar un settings.json
// viejo (ver migrate).
const SCHEMA_VERSION = 2;

// ---- API key cifrada ----
// La key se guarda cifrada con safeStorage (DPAPI en Windows: solo el mismo
// usuario en la misma máquina puede descifrarla). En el JSON queda como
// `groqApiKeyEnc` (base64) y NUNCA en texto plano. Un settings.json viejo con
// `groqApiKey` plano se migra solo la primera vez que se carga.
//
// Si el cifrado no está disponible (Linux sin keyring, por ejemplo), se cae al
// texto plano: peor que cifrado, pero mejor que perder la key.
function canEncrypt() {
  try { return app.isReady() && safeStorage.isEncryptionAvailable(); }
  catch { return false; }
}
function encryptKey(plain) {
  if (!plain) return "";
  return safeStorage.encryptString(plain).toString("base64");
}
function decryptKey(b64) {
  if (!b64) return "";
  try { return safeStorage.decryptString(Buffer.from(b64, "base64")); }
  catch (err) {
    console.error(`[settings] no se pudo descifrar la API key: ${err.message}`);
    return "";
  }
}

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

// Lee el JSON tal cual está en disco (sin descifrar ni mezclar defaults).
function readRaw() {
  try {
    return migrate(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    return { schemaVersion: SCHEMA_VERSION };
  }
}

function writeRaw(data) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`[settings] no se pudo guardar: ${err.message}`);
  }
}

// Convierte el objeto en disco al objeto que usa la app: la key descifrada en
// `groqApiKey` y el campo cifrado fuera de la vista.
function fromDisk(raw) {
  const { groqApiKeyEnc, ...rest } = raw;
  const data = { ...DEFAULTS, ...rest };
  if (groqApiKeyEnc) data.groqApiKey = decryptKey(groqApiKeyEnc);
  if (!MODEL_IDS.includes(data.model)) data.model = DEFAULTS.model;
  return data;
}

// Convierte el objeto de la app al objeto en disco: la key cifrada si se puede.
function toDisk(data) {
  const { groqApiKey, groqApiKeyEnc: _drop, ...rest } = data;
  if (groqApiKey && canEncrypt()) return { ...rest, groqApiKeyEnc: encryptKey(groqApiKey) };
  return { ...rest, groqApiKey: groqApiKey || "" };
}

function load() {
  const raw = readRaw();
  const data = fromDisk(raw);
  // Migración perezosa: una key en texto plano en disco pasa a cifrada en cuanto
  // se puede. Se hace acá y no en migrate() porque el cifrado necesita la app lista.
  if (raw.groqApiKey && canEncrypt()) writeRaw(toDisk(data));
  return data;
}

function save(partial) {
  const next = { ...load(), ...partial };
  writeRaw(toDisk(next));
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

module.exports = { load, save, settingsPath, resolveFormatDefault, DEFAULTS, SCHEMA_VERSION, MODELS, MODEL_IDS };
