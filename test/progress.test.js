/* Estado de avance (VLProgress)
 * =============================
 * Lo que se prueba es lo que el usuario lee mientras espera: la etapa, el
 * porcentaje, el transcurrido y sobre todo la estimación de lo que falta (que sale
 * de lo que tardaron las partes ya hechas, no de una tabla inventada).
 *
 * El reloj se inyecta para no depender del tiempo real.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRendererModule } = require("./helpers");

const P = loadRendererModule("progress.js", "VLProgress");

// Reloj falso: avanzar con reloj.avanzar(segundos).
let ahora = 0;
const reloj = {
  reset() { ahora = 0; },
  avanzar(seg) { ahora += seg * 1000; },
};
// Sin onRender no arranca el setInterval: los tests no dejan handles abiertos.
P.configure({ now: () => ahora });

test.beforeEach(() => { P.finish(); reloj.reset(); });

// ---- Formato de tiempos ----

test("clockText: mm:ss hasta la hora, h:mm:ss a partir de ahí", () => {
  assert.equal(P._clockText(0), "00:00");
  assert.equal(P._clockText(65), "01:05");
  assert.equal(P._clockText(3725), "1:02:05");
});

test("remainingText: sin estimación no dice nada (no inventa)", () => {
  assert.equal(P._remainingText(null), "");
  assert.equal(P._remainingText(undefined), "");
});

test("remainingText: redondea para arriba (prometer de menos molesta más)", () => {
  assert.equal(P._remainingText(10), "menos de 1 min");
  assert.equal(P._remainingText(61), "~2 min");
  assert.equal(P._remainingText(3700), "~1 h 02 min");
});

// ---- Estimación ----

test("eta: sin partes terminadas no hay estimación", () => {
  assert.equal(P._eta(0, 12, 30), null);
  assert.equal(P._eta(3, 12, 0), null);
});

test("eta: proyecta con el promedio de lo ya hecho", () => {
  // 3 partes en 30 s (10 s c/u), quedan 9 -> 90 s.
  assert.equal(P._eta(3, 12, 30), 90);
});

test("eta: con todo terminado no queda nada que estimar", () => {
  assert.equal(P._eta(12, 12, 120), null);
});

// ---- Ciclo de vida ----

test("start: el trabajo queda activo con su título y sin porcentaje todavía", () => {
  P.start({ kind: "file", title: "reunion.mp4" });
  const v = P.view();
  assert.equal(v.active, true);
  assert.equal(v.title, "reunion.mp4");
  assert.equal(v.percent, null); // barra indeterminada: trabaja, no se sabe cuánto falta
});

test("el transcurrido corre aunque la etapa no cambie (no parece colgado)", () => {
  P.start({ title: "audio.mp3" });
  P.phase("Transcribiendo…");
  reloj.avanzar(75);
  assert.equal(P.view().elapsedText, "01:15");
});

test("percent: las partes terminadas mandan; el avance dentro de la parte suma", () => {
  P.start({ title: "video.mp4" });
  P.phase("Parte 3 de 4", { steps: 4, done: 2 });
  assert.equal(P.view().percent, 50);
  P.fraction(0.5); // media parte más
  assert.equal(P.view().percent, 63);
});

test("percent: sin partes conocidas vale el avance de la etapa (ffmpeg convirtiendo)", () => {
  P.start({ title: "video.mp4" });
  P.phase("Extrayendo el audio del video…", { fraction: 0.25 });
  assert.equal(P.view().percent, 25);
});

test("estimación: se mide desde la PRIMERA parte, no desde que arrancó el trabajo", () => {
  P.start({ title: "video.mp4" });
  P.phase("Comprimiendo el audio…", { fraction: 0 });
  reloj.avanzar(600); // 10 min de ffmpeg: no dicen nada de lo que tarda Groq
  P.phase("Parte 1 de 4", { steps: 4, done: 0 });
  reloj.avanzar(20);
  P.phase("Parte 2 de 4", { steps: 4, done: 1 });
  // 1 parte en 20 s, quedan 3 -> ~60 s, no 1830.
  assert.equal(Math.round(P.view().remaining), 60);
  assert.equal(P.view().remainingText, "~1 min");
});

test("estimación: cambiar de escala (transcribir -> formatear) la reinicia", () => {
  P.start({ title: "video.mp4" });
  P.phase("Parte 1 de 4", { steps: 4, done: 0 });
  reloj.avanzar(400);
  P.phase("Parte 4 de 4", { steps: 4, done: 3 });
  // Ahora el formateo: otra escala, otro ritmo. Sin partes hechas todavía, no
  // se estima con lo que tardó Groq.
  P.phase("Dando formato (1 de 2)…", { steps: 2, done: 0 });
  assert.equal(P.view().remaining, null);
  assert.equal(P.view().percent, 0);
});

test("note: el aviso de Groq no pisa la etapa, va aparte", () => {
  P.start({ title: "audio.mp3" });
  P.phase("Transcribiendo parte 2 de 5…", { steps: 5, done: 1 });
  P.note("Groq: límite de cuota. Reintentando en 15 s… (1/3)");
  const v = P.view();
  assert.equal(v.label, "Transcribiendo parte 2 de 5…");
  assert.match(v.note, /Reintentando/);
  P.note("");
  assert.equal(P.view().note, "");
});

test("trayText: etapa, porcentaje, transcurrido y de qué archivo se trata", () => {
  P.start({ title: "reunion.mp4" });
  P.phase("Transcribiendo parte 2 de 4…", { steps: 4, done: 1 });
  reloj.avanzar(90);
  assert.equal(P.trayText(), "Transcribiendo parte 2 de 4… · 25 % · 01:30\nreunion.mp4");
});

test("finish: apaga el trabajo y entrega el mensaje final a quien dibuja", () => {
  const vistas = [];
  P.configure({ now: () => ahora, onRender: (v) => vistas.push(v) });
  P.start({ title: "audio.mp3" });
  P.phase("Guardando el .md…");
  P.finish("Listo — copiá el texto con 📋");

  const ultima = vistas[vistas.length - 1];
  assert.equal(ultima.active, false);
  assert.equal(ultima.final, "Listo — copiá el texto con 📋");
  assert.equal(P.isActive(), false);
  assert.deepEqual(P.view(), { active: false });
  P.configure({ now: () => ahora, onRender: null });
});

test("sin trabajo activo, las actualizaciones no rompen nada", () => {
  assert.equal(P.isActive(), false);
  P.phase("algo");
  P.fraction(0.5);
  P.note("x");
  P.finish("y");
  assert.equal(P.isActive(), false);
  assert.equal(P.trayText(), "");
});
