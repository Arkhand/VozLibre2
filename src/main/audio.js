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
      const bytes = new Uint8Array(fs.readFileSync(compressed));
      return { ok: true, tmpDir, duration: finalDuration, parts: [{ bytes, ext: "ogg", start: 0, end: finalDuration }] };
    }

    onStage?.({ stage: "silence" });
    const silences = await detectSilences(compressed);
    const cuts = planCutPoints(finalDuration, silences, chunkSeconds);

    onStage?.({ stage: "split", total: cuts.length + 1 });
    const files = await splitByCuts(compressed, cuts, finalDuration, tmpDir);

    const parts = files.map((p) => ({
      bytes: new Uint8Array(fs.readFileSync(p.file)),
      ext: "ogg",
      start: p.start,
      end: p.end,
    }));
    return { ok: true, tmpDir, duration: finalDuration, parts };
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
  _probeHasVideo: probeHasVideo,
};
