/* VozLibre2 — Formateo de transcripciones a Markdown (vía Claude CLI)
 * ====================================================================
 * Whisper devuelve un "choclo": texto corrido, sin párrafos ni estructura. Este
 * módulo lo pasa por el CLI de Claude ya instalado en la máquina (`claude -p`)
 * para que salga Markdown legible.
 *
 * Por qué el CLI y no otra API: ya está instalado y autenticado, no pide una key
 * nueva y no gasta la de Groq. Se invoca como subprocess con --output-format json,
 * igual que hacía el clipper de KB del que se tomó este patrón.
 *
 * También responde PREGUNTAS sobre una transcripción (ver "Preguntar" más abajo):
 * es el mismo CLI y el mismo subprocess, con otro prompt.
 *
 * QUÉ NO HACE: no inventa hablantes. Whisper no hace diarización y adivinar quién
 * habla por el contenido es una conjetura que se lee como un hecho. La estructura
 * sale de datos REALES: los silencios que ffmpeg ya midió (silencedetect) marcan
 * los cortes de párrafo, y los timestamps de los chunks marcan las secciones.
 * El modelo solo puntúa y arma párrafos; no reescribe ni resume.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { t } = require("../i18n/i18n");

// Pausa (en segundos) a partir de la cual un silencio corta párrafo. Por debajo es
// una respiración normal entre frases; por encima es un cambio de idea o de turno.
const PARAGRAPH_PAUSE = 1.2;

// Tope de caracteres por pedido al CLI. Un audio de 1 h ronda los 50k caracteres y
// entra de sobra, pero troceamos para no armar una línea de comando gigante ni
// arriesgar timeouts largos.
const MAX_CHARS_PER_CALL = 12000;

// El CLI puede tardar: es una llamada a un modelo. 3 min por trozo es holgado.
const TIMEOUT_MS = 180000;

// Preguntar en vivo es otra cosa: se pregunta EN MEDIO de la reunión y una
// respuesta que llega a los 3 minutos ya no sirve. Se corta antes y se avisa.
const ASK_TIMEOUT_MS = 90000;

// Cuánta transcripción se manda en una pregunta. Una hora de reunión ronda los
// 50k caracteres, así que esto cubre ~2 h; más arriba se manda la última parte
// (lo reciente es lo que se suele preguntar) y se avisa que se recortó.
const MAX_ASK_CHARS = 100000;

// Nombre del ejecutable según plataforma (en Windows es claude.cmd, un shim de npm).
const CLI_NAMES = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

let _cliPath = null;      // cache de la ruta resuelta
let _cliChecked = false;  // ya buscamos (aunque haya dado null)

/* Busca el ejecutable del CLI en el PATH. Resultado cacheado: se llama en cada
 * transcripción y recorrer el PATH cada vez es tirar tiempo al vacío. */
function findCli() {
  if (_cliChecked) return _cliPath;
  _cliChecked = true;

  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // En Windows los paquetes globales de npm no siempre están en el PATH del proceso
  // de Electron, así que miramos también la ruta canónica de npm.
  if (process.platform === "win32" && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, "npm"));
  }

  for (const dir of dirs) {
    for (const name of CLI_NAMES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) { _cliPath = candidate; return _cliPath; }
      } catch { /* directorio ilegible: seguimos */ }
    }
  }
  return null;
}

function isAvailable() { return findCli() !== null; }

/* Vuelve a buscar el CLI (por si el usuario lo instaló con la app abierta). */
function resetCliCache() { _cliChecked = false; _cliPath = null; _health = null; }

/* ---- ¿El CLI FUNCIONA? ----
 * Que el ejecutable exista no alcanza: puede estar sin login, o viejo y rechazado
 * por la API ("version X or newer is required"). Eso solo se ve al llamarlo. Se
 * hace una llamada mínima al arrancar (en segundo plano) y se recuerda el
 * resultado; "Volver a probar" lo repite. */
let _health = null;        // { ok, error, checkedAt } | null (nunca probado)
let _healthRunning = null; // promesa en vuelo, para no lanzar dos a la vez

async function healthCheck(force = false) {
  if (!isAvailable()) {
    _health = { ok: false, error: t("Claude CLI no encontrado."), checkedAt: Date.now() };
    return _health;
  }
  if (_health && !force) return _health;
  if (_healthRunning) return _healthRunning;
  _healthRunning = (async () => {
    console.log("claude health: probando…");
    const r = await runCli(t("Respondé únicamente con la palabra OK."));
    _health = { ok: !!r.ok, error: r.ok ? "" : (r.error || t("sin detalle")), checkedAt: Date.now() };
    console.log(`claude health: ${_health.ok ? "ok" : "FALLO: " + _health.error}`);
    _healthRunning = null;
    return _health;
  })();
  return _healthRunning;
}

function health() { return _health; }

const INSTALL_HINT = t(
  "Para el formateo automático hace falta Claude Code: instalalo con " +
  "`npm i -g @anthropic-ai/claude-code` y reabrí VozLibre."
);

/* ---------------------------------------------------------------------------
 * Preparación del texto: marcar las pausas ANTES de mandarlo al modelo
 * ------------------------------------------------------------------------- */

/* Inserta marcas de pausa en el texto de un chunk usando los silencios reales que
 * ffmpeg detectó. Devuelve el texto con "⏸" donde hubo una pausa larga.
 *
 * Whisper no nos dice a qué altura del texto cae cada silencio, así que repartimos
 * las pausas proporcionalmente: si un silencio ocurrió al 40% del chunk, la marca
 * va al corte de frase más cercano al 40% del texto. Es una aproximación, pero
 * apoyada en una pausa que EXISTIÓ de verdad — no en una corazonada del modelo.
 */
function markPauses(text, chunkStart, chunkEnd, silences) {
  const dur = chunkEnd - chunkStart;
  if (!text || !dur || dur <= 0 || !silences?.length) return text;

  // Silencios largos que caen dentro de este chunk.
  const inside = silences
    .filter((s) => s.end - s.start >= PARAGRAPH_PAUSE)
    .filter((s) => s.start >= chunkStart && s.start < chunkEnd);
  if (!inside.length) return text;

  // Cortes de frase disponibles en el texto (después de . ? ! …).
  const breaks = [];
  const re = /[.?!…]+["'”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(text)) !== null) breaks.push(m.index + m[0].length);
  if (!breaks.length) return text;

  // Para cada pausa, el corte de frase más cercano a su posición relativa.
  const used = new Set();
  for (const s of inside) {
    const target = ((s.start - chunkStart) / dur) * text.length;
    let best = null, bestDist = Infinity;
    for (const b of breaks) {
      if (used.has(b)) continue;
      const d = Math.abs(b - target);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    // Solo si el corte está razonablemente cerca (10% del texto): si no, la pausa
    // cayó en medio de una frase larga y forzarla partiría mal.
    if (best !== null && bestDist <= text.length * 0.1) used.add(best);
  }
  if (!used.size) return text;

  // Insertar las marcas de atrás hacia adelante (para no correr los índices).
  const positions = [...used].sort((a, b) => b - a);
  let out = text;
  for (const p of positions) out = out.slice(0, p) + "⏸ " + out.slice(p);
  return out;
}

/* Convierte segundos a [hh:mm:ss] o [mm:ss]. */
function stamp(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/* ---------------------------------------------------------------------------
 * El prompt
 * ------------------------------------------------------------------------- */

/* Reglas del formateo. El "sin encabezados tuyos, sin explicar" viene del prompt
 * TRANSCRIBE de ese mismo clipper: sin eso el modelo antepone "Acá está
 * el texto formateado:" y esa línea termina pegada en el .md del usuario. */
function buildPrompt(text, opts) {
  const { language, showTimestamps, sectionStart } = opts;

  const idioma = language
    ? `El audio está en ${language}. Devolvé el texto EN ESE MISMO IDIOMA.`
    : "Devolvé el texto EN EL MISMO IDIOMA en que está. No traduzcas.";

  const marcas = showTimestamps && typeof sectionStart === "number"
    ? `\n- Empezá la salida con un encabezado "### [${stamp(sectionStart)}]" seguido de un título corto (3-6 palabras) que describa de qué se habla en este fragmento.`
    : "";

  return [
    "Sos un formateador de transcripciones. Recibís texto crudo de un dictado",
    "automático (sin puntuación fiable, todo corrido) y lo devolvés legible en Markdown.",
    "",
    idioma,
    "",
    "Reglas:",
    "- NO cambies las palabras: no reescribas, no resumas, no corrijas el estilo, no",
    "  agregues ni saques contenido. Solo puntuación, mayúsculas y saltos de línea.",
    "- Corregí SOLO errores obvios de puntuación y mayúsculas de inicio de frase.",
    "- Un salto de línea simple al terminar cada frase.",
    "- Un salto DOBLE (párrafo nuevo) donde veas la marca ⏸ — es una pausa real",
    "  detectada en el audio. Quitá la marca ⏸ de la salida: es una señal para vos,",
    "  no parte del texto.",
    "- Si hay una enumeración hablada, formateala como lista con viñetas.",
    "- NO inventes quién habla. No pongas 'Hablante 1', 'Persona A' ni nada parecido,",
    "  aunque parezca un diálogo.",
    marcas,
    "- Devolvé SOLO el texto formateado. Sin comentarios, sin encabezados tuyos, sin",
    "  explicar lo que hiciste, sin envolver en bloques de código.",
    "",
    "TEXTO:",
    text,
  ].filter(Boolean).join("\n");
}

/* ---------------------------------------------------------------------------
 * Llamada al CLI
 * ------------------------------------------------------------------------- */

/* Ejecuta `claude -p` con el prompt por STDIN.
 *
 * El prompt va por stdin y no como argumento: una transcripción de 12k caracteres
 * como argv revienta el límite de línea de comandos de Windows (~32k) y además
 * quedaría el texto completo visible en la lista de procesos. */
function runCli(prompt, opts = {}) {
  const { model, timeoutMs = TIMEOUT_MS, timeoutError } = opts;
  return new Promise((resolve) => {
    const cli = findCli();
    if (!cli) return resolve({ ok: false, error: t("Claude CLI no encontrado.") + " " + INSTALL_HINT });

    const args = ["-p", "--output-format", "json"];
    if (model) args.push("--model", model);

    // En Windows `claude` es un .cmd (shim de npm) y spawn no puede ejecutarlo
    // directo: hace falta cmd.exe. Se invoca con `cmd /c` y los argumentos como
    // lista en vez de shell:true, que concatena sin escapar (DEP0190) — el prompt
    // no pasa por acá (va por stdin), pero igual no queremos armar la línea a mano.
    const isCmd = process.platform === "win32" && /\.cmd$/i.test(cli);
    const file = isCmd ? process.env.COMSPEC || "cmd.exe" : cli;
    const finalArgs = isCmd ? ["/c", cli, ...args] : args;

    let child;
    try {
      child = spawn(file, finalArgs, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: t("No se pudo ejecutar Claude CLI: {msg}", { msg: e.message }) });
    }

    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya murió */ }
      finish({ ok: false, error: timeoutError || t("El formateo tardó demasiado (más de 3 min).") });
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: t("No se pudo ejecutar Claude CLI: {msg}", { msg: e.message }) });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(parseCliOutput(code, stdout, stderr));
    });

    // El prompt entero por stdin; cerrar para que el CLI sepa que terminó.
    child.stdin.on("error", () => { /* si el proceso ya murió, el 'close' resuelve */ });
    child.stdin.end(prompt, "utf8");
  });
}

/* Interpreta lo que devolvió el CLI. Con --output-format json el sobre trae
 * `is_error`: un fallo de la API (modelo no soportado, versión vieja del CLI,
 * sin login) viene AHÍ, en `result`, con stderr vacío y a veces hasta con exit 0.
 * Sin mirar el sobre, ese texto de error terminaba pegado en el .md como si fuera
 * la transcripción, o salía un "falló (1): " sin explicación. */
function parseCliOutput(code, stdout, stderr) {
  let env = null;
  try { env = JSON.parse((stdout || "").trim()); } catch { /* no era JSON */ }
  if (env && typeof env === "object" && env.is_error) {
    const detail = String(env.result || env.error || "").slice(0, 300) || t("sin detalle");
    return { ok: false, error: t("Claude CLI devolvió un error: {detail}", { detail }) };
  }
  if (code !== 0) {
    // Sin stderr, lo único que hay para mostrar es la cola de stdout.
    const detail = (stderr.trim() || stdout.trim()).slice(-300) || t("sin detalle");
    return { ok: false, error: t("Claude CLI falló ({code}): {detail}", { code, detail }) };
  }
  return { ok: true, text: unwrap(stdout) };
}

/* Desenvuelve la respuesta del CLI: con --output-format json viene
 * {"result": "..."} y el texto real vive ahí. Si no parsea, devolvemos el crudo. */
function unwrap(raw) {
  const s = (raw || "").trim();
  try {
    const env = JSON.parse(s);
    if (env && typeof env === "object" && typeof env.result === "string") {
      return stripFences(env.result.trim());
    }
  } catch { /* no era JSON: lo tomamos tal cual */ }
  return stripFences(s);
}

/* Saca los ```markdown ... ``` con los que el modelo a veces envuelve la salida
 * pese a que se le pide que no. Mismo problema que resuelve _extract_json en
 * el clipper de KB al parsear la respuesta del CLI. */
function stripFences(s) {
  return s.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/* ---------------------------------------------------------------------------
 * Preguntar sobre una transcripción (reunión en curso)
 * ------------------------------------------------------------------------- */

/* Deja los últimos MAX_ASK_CHARS caracteres, cortando en un fin de línea para no
 * empezar a mitad de una frase. Devuelve { text, trimmed }: lo de trimmed se le
 * dice al modelo Y al usuario — una respuesta basada en media reunión sin avisar
 * es peor que no responder. */
function trimForAsk(transcript, max = MAX_ASK_CHARS) {
  const s = (transcript || "").trim();
  if (s.length <= max) return { text: s, trimmed: false };
  const cola = s.slice(-max);
  const nl = cola.indexOf("\n");
  return { text: (nl >= 0 ? cola.slice(nl + 1) : cola).trim(), trimmed: true };
}

/* Prompt de la pregunta en vivo.
 *
 * Las reglas apuntan todas al mismo lado: que la respuesta salga de lo que se dijo
 * y no del conocimiento general del modelo. "¿Se habló del presupuesto?" tiene que
 * poder contestarse "no, no aparece" — si el modelo rellena con lo que suele
 * hablarse en una reunión así, el que pregunta se entera tarde y mal.
 *
 * La pregunta va al final, después de la transcripción: es lo último que lee el
 * modelo y lo que tiene que contestar. */
function buildAskPrompt(question, transcript, opts = {}) {
  const { trimmed, elapsed } = opts;
  const hasta = typeof elapsed === "number" && elapsed > 0
    ? `La transcripción llega hasta [${stamp(elapsed)}], que es el punto en el que se pregunta.`
    : "";

  return [
    "Respondés preguntas sobre la TRANSCRIPCIÓN de una reunión que está ocurriendo",
    "ahora mismo. Quien pregunta está en esa reunión y te lee de reojo, en vivo.",
    "",
    "La transcripción es automática (Whisper): puede tener palabras mal y nombres",
    "propios deformados. Cada línea viene como \"[mm:ss] Hablante: texto\", donde",
    "\"Reunión\" es el audio de los demás participantes y \"Yo\" es el micrófono de",
    "quien te pregunta.",
    ...(hasta ? [hasta] : []),
    ...(trimmed ? ["OJO: la reunión es larga y solo se te pasa su ÚLTIMA parte; no afirmes nada sobre lo anterior."] : []),
    "",
    "Reglas:",
    "- Respondé SOLO con lo que está en la transcripción. No completes con",
    "  conocimiento general ni con lo que \"seguramente\" se dijo.",
    "- Si no está, decilo derecho: \"No aparece en lo transcripto\". Es una respuesta",
    "  útil; inventar no.",
    "- Cuando sí está, citá la marca de tiempo [mm:ss] y, si ayuda, la frase textual.",
    "- Si la transcripción es ambigua o la palabra pudo salir mal reconocida, decilo.",
    "- Breve: 1 a 4 oraciones, en texto plano. Se lee en medio de una reunión.",
    "- Respondé en el idioma de la PREGUNTA.",
    "- Sin encabezados, sin preámbulos, sin explicar lo que hiciste.",
    "",
    "TRANSCRIPCIÓN:",
    transcript,
    "",
    "PREGUNTA: " + question,
  ].join("\n");
}

/* Pregunta sobre la transcripción que va hasta ahora.
 *   question: lo que escribió el usuario
 *   transcript: el texto con marcas de tiempo (ya intercalado por pistas)
 *   opts: { elapsed, model }
 * Devuelve { ok, text, trimmed } | { ok:false, error }. */
async function ask(question, transcript, opts = {}) {
  const q = (question || "").trim();
  if (!q) return { ok: false, error: t("Escribí una pregunta.") };
  if (!isAvailable()) return { ok: false, error: t("Claude CLI no encontrado.") + " " + INSTALL_HINT };

  const { text, trimmed } = trimForAsk(transcript);
  if (!text) return { ok: false, error: t("Todavía no hay nada transcripto para consultar.") };

  const r = await runCli(buildAskPrompt(q, text, { trimmed, elapsed: opts.elapsed }), {
    model: opts.model,
    timeoutMs: ASK_TIMEOUT_MS,
    timeoutError: t("Claude tardó demasiado en responder (más de 1 min y medio)."),
  });
  return r.ok ? { ok: true, text: r.text, trimmed } : r;
}

/* ---------------------------------------------------------------------------
 * API pública
 * ------------------------------------------------------------------------- */

/* Corta el texto en trozos que entren en un pedido, sin partir frases. */
function splitForCalls(text) {
  if (text.length <= MAX_CHARS_PER_CALL) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX_CHARS_PER_CALL) {
    const window = rest.slice(0, MAX_CHARS_PER_CALL);
    // Preferimos cortar en un fin de frase; si no hay, en un espacio.
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    if (cut < MAX_CHARS_PER_CALL * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = MAX_CHARS_PER_CALL;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/* Formatea UNA parte de la transcripción.
 *   part: { text, start, end }  — texto crudo del chunk y su ubicación en el audio
 *   opts: { language, showTimestamps, silences, model, onProgress }
 * Devuelve { ok, text } | { ok:false, error }. */
async function formatPart(part, opts = {}) {
  const raw = (part.text || "").trim();
  if (!raw) return { ok: true, text: "" };

  const marked = markPauses(raw, part.start ?? 0, part.end ?? 0, opts.silences || []);
  const pieces = splitForCalls(marked);
  const outs = [];

  for (let i = 0; i < pieces.length; i++) {
    const prompt = buildPrompt(pieces[i], {
      language: opts.language,
      // El encabezado con timestamp va solo en el primer pedido de la parte: los
      // siguientes son continuación del mismo tramo de audio.
      showTimestamps: opts.showTimestamps && i === 0,
      sectionStart: part.start,
    });
    const r = await runCli(prompt, { model: opts.model });
    if (!r.ok) return r;
    outs.push(r.text);
  }
  return { ok: true, text: outs.join("\n\n") };
}

/* Formatea la transcripción completa, parte por parte.
 *   parts: [{ text, start, end }]
 * onProgress(i, total) se llama antes de cada parte para que la píldora avance. */
async function formatTranscript(parts, opts = {}) {
  if (!isAvailable()) return { ok: false, error: t("Claude CLI no encontrado.") + " " + INSTALL_HINT };

  const chunks = [];
  for (let i = 0; i < parts.length; i++) {
    opts.onProgress?.(i, parts.length);
    const r = await formatPart(parts[i], opts);
    // Una parte que falla no tira todo: se conserva el crudo de esa parte y se
    // sigue. Perder 10 min de transcripción por un timeout sería mucho peor.
    if (!r.ok) {
      chunks.push({ ok: false, text: (parts[i].text || "").trim(), error: r.error });
      continue;
    }
    chunks.push({ ok: true, text: r.text });
  }

  const failed = chunks.filter((c) => !c.ok);
  return {
    ok: true,
    text: chunks.map((c) => c.text).filter(Boolean).join("\n\n"),
    partial: failed.length > 0,
    failedCount: failed.length,
    error: failed[0]?.error || "",
  };
}

module.exports = {
  isAvailable, resetCliCache, formatTranscript, formatPart, healthCheck, health,
  ask, INSTALL_HINT, stamp,
  // expuestos para tests
  _trimForAsk: trimForAsk,
  _buildAskPrompt: buildAskPrompt,
  _markPauses: markPauses,
  _splitForCalls: splitForCalls,
  _stripFences: stripFences,
  _unwrap: unwrap,
  _parseCliOutput: parseCliOutput,
  PARAGRAPH_PAUSE,
  MAX_ASK_CHARS,
};
