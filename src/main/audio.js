/* VozLibre2 — Preparación de audio con ffmpeg (archivos largos / video)
 * =====================================================================
 * Convierte cualquier audio o video a un formato liviano que Whisper acepte y,
 * si es largo, lo parte en trozos CORTANDO EN SILENCIO (para no romper palabras).
 *
 * Por qué existe:
 *   - Un .mp4 de 1 h trae video y pesa cientos de MB: hay que extraer solo el audio.
 *   - Groq rechaza subidas de más de 25 MB y limita la duración por pedido.
 *   - Opus mono 16 kHz @ 16 kbps deja 1 h en ~8 MB SIN perder calidad de
 *     transcripción: Whisper remuestrea todo a 16 kHz igual.
 *
 * ffmpeg NO se empaqueta: se usa el del sistema. Si no está, se avisa al usuario
 * (esta función queda deshabilitada; el dictado por voz sigue funcionando).
 */

const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Audio de destino: lo que Whisper aprovecha, al mínimo peso posible.
const TARGET_RATE = 16000;   // Hz; Whisper remuestrea a 16k de todos modos
const TARGET_BITRATE = "16k";

// Duración objetivo de cada trozo (default; se puede configurar). Groq limita la
// duración por pedido; 10 min deja margen cómodo en todos los tiers.
const CHUNK_SECONDS = 600;

// Límites del ajuste configurable: menos de 1 min son pedidos desperdiciados, y
// más de 30 min empieza a chocar contra los límites por pedido de la API.
const MIN_CHUNK_MINUTES = 1;
const MAX_CHUNK_MINUTES = 30;

// Normaliza el valor que viene de la config a segundos.
function chunkSecondsFrom(minutes) {
  const n = Number(minutes);
  if (!isFinite(n) || n <= 0) return CHUNK_SECONDS;
  return Math.round(Math.min(MAX_CHUNK_MINUTES, Math.max(MIN_CHUNK_MINUTES, n)) * 60);
}

// Cuánto se permite retroceder desde el corte teórico buscando un silencio.
// Si no hay ninguno en esa ventana, se corta seco en el límite.
const SILENCE_SEARCH_WINDOW = 90;

// Parámetros de silencedetect: -30 dB durante 0.4 s es una pausa de habla normal.
const SILENCE_NOISE_DB = "-30dB";
const SILENCE_MIN_DUR = 0.4;

// Solo se parte si el audio supera el 20% por encima del trozo objetivo (no tiene
// sentido cortar 11 minutos en 10 + 1).
const SPLIT_MARGIN = 1.2;
const SPLIT_THRESHOLD_SECONDS = CHUNK_SECONDS * SPLIT_MARGIN;

// ---- Recorte de silencios antes de subir ----
// Un silencio largo al principio de un trozo hace DEGENERAR a Whisper: un chunk
// real de 30 s con 9 s de silencio volvió como "y y y y y y y y", y el mismo audio
// sin ese silencio transcribió perfecto. Además el silencio gasta cuota (se paga
// por segundo de audio) sin aportar una sola palabra.
//
// Se recorta cortando los tramos con voz y pegándolos (atrim + concat), dejando un
// colchón para no comerse el arranque de las palabras, y se guarda un MAPA para
// devolver los tiempos a la línea real del audio: sin el mapa, los timestamps del
// transcript quedarían corridos por todo lo que se sacó.
const TRIM_KEEP = 0.4;       // silencio que se conserva a cada lado de la voz
const TRIM_MIN_SILENCE = 1.5; // pausas más cortas no se tocan (respiración normal)
// Por debajo de esto no vale la pena: reprocesar cuesta más que lo que se ahorra.
const TRIM_MIN_GAIN = 0.10;   // 10% de la duración

function splitThresholdFor(chunkSeconds) { return chunkSeconds * SPLIT_MARGIN; }

// ---------------------------------------------------------------------------
// Localizar ffmpeg / ffprobe
// ---------------------------------------------------------------------------
// Buscamos en PATH y en las rutas típicas de winget/chocolatey, porque una
// instalación por winget no siempre deja el PATH actualizado en la sesión que
// heredó Electron.
function candidatePaths(bin) {
  const exe = process.platform === "win32" ? bin + ".exe" : bin;
  const home = os.homedir();
  return [
    exe, // PATH
    path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", exe),
    path.join("C:\\", "ProgramData", "chocolatey", "bin", exe),
    path.join("C:\\", "ffmpeg", "bin", exe),
    path.join("C:\\", "Program Files", "ffmpeg", "bin", exe),
    "/usr/bin/" + bin,
    "/usr/local/bin/" + bin,
    "/opt/homebrew/bin/" + bin,
  ];
}

// Cache: la búsqueda lanza procesos y esto se consulta seguido.
const resolved = {};

function locate(bin) {
  if (resolved[bin] !== undefined) return resolved[bin];
  for (const p of candidatePaths(bin)) {
    try {
      // -version es instantáneo y confirma que el binario corre de verdad (no
      // alcanza con que el archivo exista: puede ser un stub roto).
      execFileSync(p, ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      resolved[bin] = p;
      return p;
    } catch { /* siguiente candidato */ }
  }
  resolved[bin] = null;
  return null;
}

function ffmpegPath() { return locate("ffmpeg"); }
function ffprobePath() { return locate("ffprobe"); }

// ¿Está disponible la preparación de audio? El renderer lo consulta para avisar
// "instalá ffmpeg" en vez de fallar a mitad de camino.
function isAvailable() { return !!ffmpegPath() && !!ffprobePath(); }

const INSTALL_HINT =
  "Para transcribir videos o audios largos hace falta ffmpeg. " +
  "Instalalo con: winget install Gyan.FFmpeg — después reiniciá VozLibre.";

// ---------------------------------------------------------------------------
// Helpers de proceso
// ---------------------------------------------------------------------------
function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (onStderr) onStderr(s);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve(err);
      // ffmpeg escupe mucho ruido: nos quedamos con las últimas líneas, que son
      // donde suele estar la causa real.
      const tail = err.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      reject(new Error(tail || "ffmpeg salió con código " + code));
    });
  });
}

// Duración en segundos (o null si no se puede leer).
function probeDuration(file) {
  return new Promise((resolve) => {
    const bin = ffprobePath();
    if (!bin) return resolve(null);
    execFile(bin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: 30000, windowsHide: true },
      (e, stdout) => {
        const n = parseFloat(String(stdout).trim());
        resolve(e || !isFinite(n) ? null : n);
      });
  });
}

// ¿El archivo trae pista de audio? Un .mp4 mudo no sirve y conviene decirlo
// antes de procesar nada.
function probeHasAudio(file) {
  return new Promise((resolve) => {
    const bin = ffprobePath();
    if (!bin) return resolve(true); // sin ffprobe no bloqueamos; ffmpeg dirá
    execFile(bin,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", file],
      { timeout: 30000, windowsHide: true },
      (e, stdout) => resolve(!e && String(stdout).trim().length > 0));
  });
}

// ¿Trae pista de video? No alcanza con mirar la extensión: un .mp4 puede ser
// solo audio y un .webm puede ser cualquiera de las dos cosas. Se lo preguntamos
// al archivo para que el mensaje al usuario diga la verdad.
function probeHasVideo(file) {
  return new Promise((resolve) => {
    const bin = ffprobePath();
    if (!bin) return resolve(false);
    execFile(bin,
      // Se descartan las carátulas embebidas (mp3 con tapa del disco), que son
      // "video" para ffprobe pero una sola imagen fija.
      ["-v", "error", "-select_streams", "V", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", file],
      { timeout: 30000, windowsHide: true },
      (e, stdout) => resolve(!e && String(stdout).trim().length > 0));
  });
}

// ---------------------------------------------------------------------------
// Conversión y corte
// ---------------------------------------------------------------------------
// Extrae el audio (descarta video con -vn) y lo comprime a Opus mono 16 kHz.
// onProgress recibe 0..1 estimado a partir del "time=" que reporta ffmpeg.
async function toOpus(input, output, totalSeconds, onProgress) {
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    "-i", input,
    "-vn",                       // sin video: es lo que salva los .mp4 pesados
    "-ac", "1",                  // mono
    "-ar", String(TARGET_RATE),
    "-c:a", "libopus",
    "-b:a", TARGET_BITRATE,
    output,
  ];
  await run(ffmpegPath(), args, {
    onStderr: (s) => {
      if (!onProgress || !totalSeconds) return;
      // ffmpeg -stats emite "time=00:01:23.45" mientras trabaja.
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (!m) return;
      const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      onProgress(Math.max(0, Math.min(1, sec / totalSeconds)));
    },
  });
}

// Lista de silencios [{start, end}] detectados en el audio.
async function detectSilences(file) {
  const out = await run(ffmpegPath(), [
    "-hide_banner", "-nostats", "-i", file,
    "-af", "silencedetect=noise=" + SILENCE_NOISE_DB + ":d=" + SILENCE_MIN_DUR,
    "-f", "null", "-",
  ]).catch(() => "");   // si falla la detección seguimos con cortes secos

  const silences = [];
  let start = null;
  for (const line of String(out).split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { start = parseFloat(s[1]); continue; }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      silences.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  return silences;
}

/* Tramos con voz a partir de los silencios detectados, con un colchón a cada lado.
 * Devuelve [{start, end}] en segundos sobre el audio original.
 *
 * Se calcula por complemento: lo que NO es un silencio largo, es voz. Solo cuentan
 * los silencios de al menos TRIM_MIN_SILENCE — las pausas cortas son parte del
 * habla y sacarlas encadenaría las palabras.
 */
function voicedSpans(duration, silences) {
  const largos = (silences || [])
    .filter((s) => s.end - s.start >= TRIM_MIN_SILENCE)
    .sort((a, b) => a.start - b.start);
  if (!largos.length) return [{ start: 0, end: duration }];

  const spans = [];
  let cursor = 0;
  for (const s of largos) {
    // El colchón se le devuelve a la voz, no al silencio. Ojo: solo hay voz que
    // proteger si el silencio empieza DESPUÉS del cursor. Un silencio que arranca
    // en el cursor (típicamente en 0) no tiene nada delante, y sumarle el colchón
    // dejaría un tramo de puro silencio — justo lo que venimos a sacar.
    if (s.start > cursor) {
      spans.push({ start: cursor, end: Math.min(duration, s.start + TRIM_KEEP) });
    }
    cursor = Math.max(cursor, Math.min(duration, s.end - TRIM_KEEP));
    // El silencio llega hasta el final: no queda voz después, así que el colchón
    // que dejó el cursor sería otro tramo de puro silencio. Cerramos acá.
    if (s.end >= duration) { cursor = duration; break; }
  }
  if (cursor < duration) spans.push({ start: cursor, end: duration });

  // Unir los que quedaron pegados o solapados tras aplicar el colchón.
  const unidos = [];
  for (const sp of spans) {
    const ult = unidos[unidos.length - 1];
    if (ult && sp.start <= ult.end) ult.end = Math.max(ult.end, sp.end);
    else if (sp.end > sp.start) unidos.push({ ...sp });
  }
  return unidos;
}

/* Recorta los silencios de un archivo y devuelve {file, mapping, saved} o null si
 * no vale la pena. `mapping` es [{at, real, len}]: `at` es el tiempo en el archivo
 * recortado, `real` el tiempo equivalente en el original y `len` cuánto dura ese
 * tramo — con eso el renderer devuelve cualquier timestamp a la línea real.
 */
async function trimSilence(file, duration, silences, outPath) {
  const spans = voicedSpans(duration, silences);
  if (!spans.length) return null;

  const conVoz = spans.reduce((acc, s) => acc + (s.end - s.start), 0);
  if (conVoz <= 0) return null;
  // Si casi no hay silencio que sacar, no vale reprocesar el archivo.
  if (duration - conVoz < duration * TRIM_MIN_GAIN) return null;

  // Un filtro por tramo + concat: más predecible que silenceremove, que decide por
  // energía y no deja saber qué sacó (y sin eso no se puede armar el mapa).
  const partes = spans
    .map((s, i) => `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
    .join(";");
  const entradas = spans.map((_, i) => `[a${i}]`).join("");
  const filtro = `${partes};${entradas}concat=n=${spans.length}:v=0:a=1[out]`;

  try {
    await run(ffmpegPath(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", file,
      "-filter_complex", filtro,
      "-map", "[out]",
      "-c:a", "libopus", "-b:a", "24k", "-ac", "1",
      outPath,
    ]);
  } catch {
    return null; // si el recorte falla seguimos con el audio completo
  }

  const mapping = [];
  let at = 0;
  for (const s of spans) {
    const len = s.end - s.start;
    mapping.push({ at, real: s.start, len });
    at += len;
  }
  return { file: outPath, mapping, saved: duration - conVoz, kept: conVoz };
}

// Decide los puntos de corte respetando los silencios y el máximo configurado.
//
// La idea NO es llenar cada trozo hasta el tope y dejar el resto como cola: eso
// daba repartos feos (con tope de 30 min, 33.8 min salían como 30 + 3.8). En vez
// de eso se calcula PRIMERO cuántas partes hacen falta —el mínimo que respeta el
// tope— y se reparte parejo entre ellas. Con 33.8 min y tope 30 son 2 partes de
// ~17 min: menos pedidos desperdiciados y trozos parejos.
//
// Sobre cada punto ideal se busca el silencio más cercano (hacia atrás o hacia
// adelante) para no cortar a mitad de palabra. Se prefiere la pausa MÁS LARGA
// entre las cercanas, porque es la que con más probabilidad separa dos frases;
// entre pausas parecidas gana la que quede más cerca del punto ideal.
function planCutPoints(duration, silences, chunkSeconds = CHUNK_SECONDS) {
  if (!duration || duration <= chunkSeconds) return [];

  // Mínimo de partes que respeta el tope, y largo parejo para todas.
  const nParts = Math.ceil(duration / chunkSeconds);
  const ideal = duration / nParts;

  const cuts = [];
  let prev = 0;
  for (let i = 1; i < nParts; i++) {
    const target = i * ideal;
    // La búsqueda no puede pasarse del tope respecto del corte anterior, ni
    // dejar un trozo ridículamente corto.
    // Piso duro: si este corte queda demasiado atrás, lo que sobra al final no
    // entra en el tope. Cada corte i debe estar como mínimo a `duration - (partes
    // que faltan) * tope`, o la cola termina excediéndose (y la última parte no
    // tiene ningún corte posterior que la recorte).
    const minPorCola = duration - (nParts - i) * chunkSeconds;
    const lo = Math.max(prev + 30, target - SILENCE_SEARCH_WINDOW, minPorCola);
    // El techo tiene tres frenos: el tope respecto del corte anterior, la ventana
    // de búsqueda, y —clave— dejar lo suficiente para que las partes que faltan
    // entren en el tope. Sin este último, la ÚLTIMA parte podía pasarse (nadie la
    // limitaba, porque no tiene un corte después que la recorte).
    const hi = Math.min(target + SILENCE_SEARCH_WINDOW, prev + chunkSeconds, duration - 1);
    if (hi < lo) { // ventana imposible: corte seco respetando ambos límites
      const cut = Math.max(lo, Math.min(target, prev + chunkSeconds));
      cuts.push(cut);
      prev = cut;
      continue;
    }

    let best = null, bestScore = -Infinity;
    for (const s of silences) {
      // Cortamos en el medio de la pausa: deja aire a ambos lados.
      const mid = (s.start + s.end) / 2;
      if (mid < lo || mid > hi) continue;
      const pausa = s.end - s.start;
      const distancia = Math.abs(mid - target);
      // Pausas más largas y más cercanas al ideal puntúan mejor. El peso de la
      // distancia (1/30 por segundo) hace que una pausa el doble de larga gane
      // solo si no está mucho más lejos.
      const score = Math.min(pausa, 3) - distancia / 30;
      if (score > bestScore) { bestScore = score; best = mid; }
    }

    // Sin ningún silencio en la ventana: corte seco en el punto ideal (recortado
    // para no violar el tope). Es raro, pero mejor eso que un trozo gigante.
    const cut = best === null ? Math.max(lo, Math.min(target, prev + chunkSeconds)) : best;
    cuts.push(cut);
    prev = cut;
  }
  return cuts;
}

// Corta el .ogg ya comprimido en trozos, sin recodificar (-c copy = instantáneo).
async function splitByCuts(file, cuts, duration, outDir) {
  const bounds = [0, ...cuts, duration];
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    const out = path.join(outDir, "part-" + String(i + 1).padStart(2, "0") + ".ogg");
    await run(ffmpegPath(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", file,
      "-ss", from.toFixed(3),
      "-to", to.toFixed(3),
      "-c", "copy",
      out,
    ]);
    parts.push({ file: out, start: from, end: to });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
// Analiza un archivo SIN convertir nada: duración y en cuántas partes saldría.
// Sirve para preguntarle al usuario antes de gastar API.
async function inspect(file, chunkMinutes) {
  if (!isAvailable()) return { ok: false, needsFfmpeg: true, error: INSTALL_HINT };
  try {
    if (!(await probeHasAudio(file))) {
      return { ok: false, error: "Ese archivo no tiene pista de audio." };
    }
    const duration = await probeDuration(file);
    if (duration === null) return { ok: false, error: "No se pudo leer la duración del archivo." };
    const chunkSeconds = chunkSecondsFrom(chunkMinutes);
    const parts = duration > splitThresholdFor(chunkSeconds) ? Math.ceil(duration / chunkSeconds) : 1;
    const hasVideo = await probeHasVideo(file);
    return { ok: true, duration, parts, hasVideo, chunkMinutes: chunkSeconds / 60 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Prepara el archivo para transcribir: extrae audio, comprime y (si hace falta)
// parte en trozos. Devuelve {ok, parts:[{bytes, ext, start, end}], tmpDir}.
// El llamador DEBE invocar cleanup(tmpDir) cuando termine.
async function prepare(file, onStage, chunkMinutes) {
  if (!isAvailable()) return { ok: false, needsFfmpeg: true, error: INSTALL_HINT };

  const chunkSeconds = chunkSecondsFrom(chunkMinutes);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vozlibre-"));
  try {
    const duration = await probeDuration(file);
    const compressed = path.join(tmpDir, "audio.ogg");

    onStage?.({ stage: "convert", progress: 0 });
    await toOpus(file, compressed, duration, (p) => onStage?.({ stage: "convert", progress: p }));

    // La duración del comprimido es la de referencia para cortar (puede diferir
    // por milésimas de la del original).
    const finalDuration = (await probeDuration(compressed)) ?? duration ?? 0;

    if (!finalDuration || finalDuration <= splitThresholdFor(chunkSeconds)) {
      // Aunque no haya que cortar, los silencios se detectan igual: sirven para
      // recortar antes de subir y para que el formateador separe párrafos.
      let silences = [];
      try { silences = await detectSilences(compressed); } catch { /* seguimos sin pausas */ }

      // Recorte de silencios: evita que Whisper alucine y gasta menos cuota.
      let subir = compressed, mapping = null;
      if (silences.length) {
        onStage?.({ stage: "trim" });
        const t = await trimSilence(
          compressed, finalDuration, silences, path.join(tmpDir, "trim.ogg")
        );
        if (t) { subir = t.file; mapping = t.mapping; }
      }

      const bytes = new Uint8Array(fs.readFileSync(subir));
      return {
        ok: true, tmpDir, duration: finalDuration, silences,
        parts: [{ bytes, ext: "ogg", start: 0, end: finalDuration, mapping }],
      };
    }

    onStage?.({ stage: "silence" });
    const silences = await detectSilences(compressed);
    const cuts = planCutPoints(finalDuration, silences, chunkSeconds);

    onStage?.({ stage: "split", total: cuts.length + 1 });
    const files = await splitByCuts(compressed, cuts, finalDuration, tmpDir);

    // Recorte de silencios por parte. Cada trozo se recorta contra los silencios
    // que caen dentro de él, y guarda su propio mapa para devolver los tiempos a
    // la línea real del audio.
    onStage?.({ stage: "trim" });
    const parts = [];
    for (let i = 0; i < files.length; i++) {
      const p = files[i];
      const dur = p.end - p.start;
      // Silencios de esta parte, con los tiempos relativos al inicio del trozo.
      const propios = silences
        .filter((s) => s.end > p.start && s.start < p.end)
        .map((s) => ({
          start: Math.max(0, s.start - p.start),
          end: Math.min(dur, s.end - p.start),
        }));

      let subir = p.file, mapping = null;
      if (propios.length) {
        const t = await trimSilence(
          p.file, dur, propios, path.join(tmpDir, `trim-${String(i + 1).padStart(2, "0")}.ogg`)
        );
        if (t) { subir = t.file; mapping = t.mapping; }
      }
      parts.push({
        bytes: new Uint8Array(fs.readFileSync(subir)),
        ext: "ogg",
        start: p.start,
        end: p.end,
        mapping,
      });
    }

    // Los silencios viajan al renderer: el formateador los usa para cortar párrafos
    // donde hubo una pausa REAL en el audio, en vez de que el modelo lo adivine.
    return { ok: true, tmpDir, duration: finalDuration, parts, silences };
  } catch (e) {
    cleanup(tmpDir);
    return { ok: false, error: "No se pudo preparar el audio: " + e.message };
  }
}

// Borra el directorio temporal con los trozos.
function cleanup(tmpDir) {
  if (!tmpDir) return;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ya no está */ }
}

module.exports = {
  isAvailable, inspect, prepare, cleanup,
  INSTALL_HINT, CHUNK_SECONDS, SPLIT_THRESHOLD_SECONDS,
  MIN_CHUNK_MINUTES, MAX_CHUNK_MINUTES, chunkSecondsFrom, splitThresholdFor,
  // expuestos para tests
  _planCutPoints: planCutPoints,
  _voicedSpans: voicedSpans,
  _trimSilence: trimSilence,
  _probeHasVideo: probeHasVideo,
};
