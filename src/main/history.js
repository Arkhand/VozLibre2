/* VozLibre2 — Historial de transcripciones de archivos
 * =====================================================
 * Guarda cada transcripción de ARCHIVO (📎 / drag & drop) como un .md en la carpeta
 * que elija el usuario, y mantiene un índice liviano en userData para poder listar
 * el historial en la píldora sin escanear la carpeta entera.
 *
 * El push-to-talk NO pasa por acá: es dictado efímero que va a otra app, y guardar
 * un .md por cada frase dictada llenaría la carpeta de basura.
 *
 * Por qué índice aparte y no leer los .md: el listado tiene que abrirse instantáneo
 * y sobrevivir a que muevas o renombres los archivos. El índice guarda la ruta; si
 * el .md ya no está, la entrada se marca como faltante en vez de desaparecer sin
 * explicación (misma idea de metadata y fuente guardadas por separado).
 */

const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { t } = require("../i18n/i18n");

// Tope de entradas en el índice. Las más viejas se van cayendo: el índice es para
// "lo que transcribí últimamente", no un archivo histórico (los .md quedan siempre).
const MAX_ENTRIES = 200;

function indexPath() {
  return path.join(app.getPath("userData"), "history.json");
}

/* Carpeta por defecto: Documentos\VozLibre. No se crea hasta que haya algo que
 * guardar (no queremos ensuciar Documentos si el usuario nunca transcribe un archivo). */
function defaultFolder() {
  try {
    return path.join(app.getPath("documents"), "VozLibre");
  } catch {
    return path.join(app.getPath("userData"), "transcripciones");
  }
}

// Las reuniones grabadas van a su propia subcarpeta: son otra cosa que un archivo
// que mandaste a transcribir, y mezclarlas hace que no se encuentre ninguna.
const MEETINGS_SUBDIR = "Reuniones";

function folderFor(kind, base) {
  const root = base || defaultFolder();
  return kind === "meeting" ? path.join(root, MEETINGS_SUBDIR) : root;
}

function loadIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function saveIndex(entries) {
  try {
    fs.writeFileSync(
      indexPath(),
      JSON.stringify({ version: 1, entries: entries.slice(0, MAX_ENTRIES) }, null, 2),
      "utf8"
    );
    return true;
  } catch (err) {
    console.error(`[history] no se pudo guardar el índice: ${err.message}`);
    return false;
  }
}

/* Nombre de archivo seguro a partir del nombre original del audio.
 * Misma lógica de saneado que usa el clipper de KB. */
function safeName(name) {
  const base = path.basename(name || "", path.extname(name || "")) || "transcripcion";
  return base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")        // sacar tildes
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") // ilegales en Windows
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 60) || "transcripcion";
}

/* Si ya existe un archivo con ese nombre, agrega -2, -3… en vez de pisarlo.
 * Transcribir dos veces el mismo audio no debe borrar la primera versión. */
function dedupe(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i++;
  }
  return candidate;
}

function fmtDuration(seconds) {
  const s = Math.round(seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

const LANG_NAMES = {
  es: "Español", en: "Inglés", pt: "Portugués", fr: "Francés", it: "Italiano",
  de: "Alemán", ca: "Catalán", gl: "Gallego", eu: "Euskera", nl: "Neerlandés",
  ja: "Japonés", zh: "Chino", ru: "Ruso", ar: "Árabe",
};
function langName(code) { return LANG_NAMES[code] ? t(LANG_NAMES[code]) : (code || t("desconocido")); }

/* Arma el .md completo: frontmatter YAML + cuerpo.
 * El frontmatter permite reconstruir el historial leyendo el archivo, aunque se
 * pierda el índice. */
function buildMarkdown(meta, body) {
  // Ojo con filter(Boolean) acá: descarta los "" y se come las líneas en blanco,
  // dejando el cierre "---" pegado al título. Los campos opcionales se filtran
  // ANTES de añadir el cierre, y el salto final va aparte.
  const campos = [
    `titulo: ${meta.title}`,
    `archivo: ${meta.sourceName}`,
    `fecha: ${meta.date}`,
    meta.kind === "meeting" ? "tipo: reunion" : null,
    `duracion: ${fmtDuration(meta.duration)}`,
    meta.language ? `idioma: ${meta.language}` : null,
    `formateado: ${meta.formatted ? "true" : "false"}`,
    meta.partial ? "formateo_parcial: true" : null,
    meta.rawFile ? `crudo: ${meta.rawFile}` : null,
    meta.formattedFile ? `formateado_en: ${meta.formattedFile}` : null,
  ].filter(Boolean);
  const fm = `---\n${campos.join("\n")}\n---\n\n`;

  const head = `# ${meta.title}\n\n`;
  const sub =
    `_${meta.sourceName} — ${fmtDuration(meta.duration)}` +
    (meta.language ? ` — ${langName(meta.language)}` : "") +
    `_\n`;

  // Aviso visible cuando el texto NO pasó por el formateador: quien abra el .md
  // tiene que saber por qué está sin estructura, si no parece un bug. El crudo
  // guardado a propósito (al lado del formateado) no es un problema: se dice
  // qué es y dónde está el otro.
  const warn = meta.raw
    ? "\n> " + t("📝 Texto crudo, tal cual lo devolvió la transcripción. La versión formateada está en `{file}`.", { file: meta.formattedFile }) + "\n"
    : !meta.formatted
    ? "\n> " + t("⚠️ Sin formatear: {reason}.", { reason: meta.formatError || t("el formateo automático no estaba disponible") }) +
      "\n> " + t("El texto está tal cual lo devolvió la transcripción.") + "\n"
    : meta.partial
      ? "\n> " + t("⚠️ Formateo parcial: {n} parte(s) quedaron sin formatear.", { n: meta.failedCount }) + "\n"
      : "";

  return `${fm}${head}${sub}${warn}\n${body.trim()}\n`;
}

/* Nombre del archivo crudo a partir del formateado: "x.md" -> "x.crudo.md".
 * Van juntos en la carpeta, uno al lado del otro, para que se encuentren. */
function rawNameFor(mdPath) {
  return mdPath.replace(/\.md$/i, "") + ".crudo.md";
}

/* Guarda la transcripción y la registra en el índice.
 *   opts: { folder, sourceName, sourcePath, duration, language, text, rawText,
 *           formatted, partial, failedCount, formatError }
 * Si el texto pasó por el formateador, se guardan DOS archivos: el .md formateado
 * y, al lado, el .crudo.md con el texto tal cual lo devolvió Whisper. El crudo es
 * la fuente de verdad: si el formateo se comió algo o cambió una palabra, ahí está
 * el original para comparar.
 * Devuelve { ok, path, rawPath, entry } | { ok:false, error }. */
function save(opts) {
  // Las reuniones van a su propia subcarpeta para no mezclarse con los archivos
  // que el usuario mandó a transcribir.
  const folder = folderFor(opts.kind, opts.folder);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (e) {
    return { ok: false, error: t("No se pudo crear la carpeta \"{folder}\": {msg}", { folder, msg: e.message }) };
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const title = path.basename(opts.sourceName || "", path.extname(opts.sourceName || "")) || t("Transcripción");
  const filename = `${date}_${safeName(opts.sourceName)}.md`;
  const target = dedupe(folder, filename);

  // El crudo se guarda aparte solo si el texto principal es otro (pasó por el
  // formateador). Sin formateo el .md principal YA es el crudo.
  const rawText = (opts.rawText || "").trim();
  const saveRaw = !!opts.formatted && !!rawText && rawText !== (opts.text || "").trim();
  const rawTarget = saveRaw ? dedupe(folder, path.basename(rawNameFor(target))) : "";

  const meta = {
    kind: opts.kind === "meeting" ? "meeting" : "file",
    title,
    sourceName: opts.sourceName || t("(desconocido)"),
    date,
    duration: opts.duration,
    language: opts.language,
    formatted: !!opts.formatted,
    partial: !!opts.partial,
    failedCount: opts.failedCount || 0,
    formatError: opts.formatError || "",
    rawFile: rawTarget ? path.basename(rawTarget) : "",
  };

  const writeError = (e) => {
    if (e.code === "EACCES" || e.code === "EPERM") {
      return { ok: false, error: t("Sin permisos para escribir en \"{folder}\".", { folder }) };
    }
    if (e.code === "ENOSPC") return { ok: false, error: t("No queda espacio en el disco.") };
    return { ok: false, error: t("No se pudo guardar el .md: {msg}", { msg: e.message }) };
  };

  try {
    fs.writeFileSync(target, buildMarkdown(meta, opts.text || ""), "utf8");
  } catch (e) {
    return writeError(e);
  }
  if (rawTarget) {
    // El crudo lleva su propio frontmatter (formateado: false) y apunta al
    // formateado, así cualquiera de los dos lleva al otro.
    const rawMeta = { ...meta, formatted: false, partial: false, formatError: "", rawFile: "", raw: true, formattedFile: path.basename(target) };
    try {
      fs.writeFileSync(rawTarget, buildMarkdown(rawMeta, rawText), "utf8");
    } catch (e) {
      return writeError(e);
    }
  }

  const entry = {
    kind: meta.kind,
    id: `${now.getTime()}-${Math.floor(now.getTime() % 100000)}`,
    title,
    sourceName: meta.sourceName,
    path: target,
    rawPath: rawTarget || "",
    savedAt: now.toISOString(),
    duration: opts.duration || 0,
    language: opts.language || "",
    formatted: meta.formatted,
    partial: meta.partial,
    chars: (opts.text || "").length,
  };

  saveIndex([entry, ...loadIndex()]);
  return { ok: true, path: target, rawPath: rawTarget || "", entry };
}

/* Lista el historial. Marca `missing` las entradas cuyo .md ya no está en disco
 * (lo moviste o lo borraste) en vez de ocultarlas sin decir nada. */
function list() {
  return loadIndex().map((e) => ({
    ...e,
    missing: !safeExists(e.path),
    // hasRaw: hay un .crudo.md guardado Y sigue en disco.
    hasRaw: !!e.rawPath && safeExists(e.rawPath),
  }));
}

/* Ruta del archivo pedido: "raw" -> el crudo, cualquier otra cosa -> el principal. */
function pathFor(entry, which) {
  return which === "raw" ? (entry.rawPath || "") : entry.path;
}

function safeExists(p) {
  try { return typeof p === "string" && fs.existsSync(p); } catch { return false; }
}

/* Devuelve el CUERPO del .md (sin frontmatter), para mostrarlo en la píldora.
 * which: "raw" lee el .crudo.md; por defecto el principal. */
function read(id, which = "") {
  const entry = loadIndex().find((e) => e.id === id);
  if (!entry) return { ok: false, error: t("Esa transcripción ya no está en el historial.") };
  const file = pathFor(entry, which);
  if (!file) return { ok: false, error: t("Esta transcripción no tiene versión cruda guardada.") };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    return { ok: true, text: body, entry };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { ok: false, error: t("El archivo ya no está en {path}", { path: file }) };
    }
    return { ok: false, error: t("No se pudo leer el archivo: {msg}", { msg: e.message }) };
  }
}

/* Saca una entrada del índice. Con `alsoFile` manda además el .md a la Papelera
 * de reciclaje (no lo borra del disco): si el usuario se equivocó, lo recupera
 * desde Windows. La UI pregunta antes de llegar acá.
 *
 * Si el archivo no se puede mandar a la Papelera, la entrada NO se saca del
 * índice: dejar el .md en disco y desaparecerlo de la lista es la peor mezcla. */
async function remove(id, alsoFile = false) {
  const entries = loadIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: t("Entrada no encontrada.") };

  // Van juntos a la Papelera el formateado y, si existe, el crudo.
  if (alsoFile) {
    for (const f of [entry.path, entry.rawPath]) {
      if (!f || !fs.existsSync(f)) continue;
      try {
        await shell.trashItem(f);
      } catch (e) {
        return { ok: false, error: t("No se pudo mandar el archivo a la Papelera: {msg}", { msg: e.message }) };
      }
    }
  }
  saveIndex(entries.filter((e) => e.id !== id));
  return { ok: true, trashed: !!alsoFile };
}

function clear() {
  saveIndex([]);
  return { ok: true };
}

module.exports = {
  save, list, read, remove, clear, pathFor,
  defaultFolder, folderFor, indexPath, buildMarkdown, MEETINGS_SUBDIR, rawNameFor,
  // expuestos para tests
  _safeName: safeName,
  _dedupe: dedupe,
  fmtDuration, langName,
};
