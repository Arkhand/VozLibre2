/* VozLibre2 — Log a archivo
 * ==========================
 * En el .exe empaquetado no hay consola: todo lo que iba a console.error se
 * perdía. Este módulo lo manda además a un archivo, para poder pedir "mandame el
 * log" en vez de adivinar:
 *
 *   %APPDATA%\VozLibre2\logs\vozlibre.log   (rota a .1, .2, .3 al pasar 1 MB)
 *
 * Qué entra: console.log/warn/error del main, excepciones no atrapadas, y lo que
 * el renderer mande por IPC (errores visibles en la píldora, fallos de API).
 * Qué NO entra nunca: la API key. Los mensajes de error de la API se escriben tal
 * cual llegan, pero la key no viaja en ellos.
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 1024 * 1024;   // rota al pasar 1 MB
const KEEP = 3;                  // vozlibre.1.log … vozlibre.3.log
const MAX_MSG = 4000;            // un mensaje del renderer no puede inundar el log

let dir = null;
let file = null;

function logDir() { return path.join(app.getPath("userData"), "logs"); }
function filePath() { return file; }

function rotateIfNeeded() {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < MAX_BYTES) return;
  try {
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? file : path.join(dir, `vozlibre.${i - 1}.log`);
      const to = path.join(dir, `vozlibre.${i}.log`);
      if (i === KEEP && fs.existsSync(to)) fs.unlinkSync(to);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch { /* si no se puede rotar, se sigue escribiendo en el mismo */ }
}

function stringify(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function write(level, source, msg) {
  if (!file) return;
  const line = `${new Date().toISOString()} [${level}] [${source}] ${String(msg).slice(0, MAX_MSG)}\n`;
  try {
    fs.appendFileSync(file, line, "utf8");
    rotateIfNeeded();
  } catch { /* disco lleno o sin permisos: no hay dónde quejarse */ }
}

/* Engancha console.* del main al archivo y captura excepciones sueltas. Se llama
 * una vez, apenas la app está lista (necesita userData). */
function init() {
  dir = logDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
  file = path.join(dir, "vozlibre.log");

  const orig = { log: console.log, warn: console.warn, error: console.error };
  const levels = { log: "info", warn: "warn", error: "error" };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => {
      orig[k](...args);
      write(levels[k], "main", args.map(stringify).join(" "));
    };
  }
  process.on("uncaughtException", (e) => write("error", "main", "uncaughtException: " + stringify(e)));
  process.on("unhandledRejection", (r) => write("error", "main", "unhandledRejection: " + stringify(r)));
  return true;
}

// Lo que manda el renderer por IPC. level: "info" | "warn" | "error".
function fromRenderer(level, msg) {
  const lvl = ["info", "warn", "error"].includes(level) ? level : "info";
  write(lvl, "renderer", stringify(msg));
}

module.exports = { init, write, fromRenderer, logDir, filePath };
