const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRendererModule } = require("./helpers");

const TR = loadRendererModule("transcription.js", "VLTranscription");

// Un segmento "bueno" según los umbrales medidos (avg_logprob >= -0.6).
const seg = (start, end, text, extra = {}) => ({ start, end, text, avg_logprob: -0.2, no_speech_prob: 0.01, ...extra });
const word = (start, end, w) => ({ start, end, word: w });

test("cleanSegments: descarta las invenciones por avg_logprob", () => {
  const data = {
    segments: [
      seg(0, 2, "Hola qué tal"),
      seg(2, 4, "Gracias por ver el video", { avg_logprob: -1.2 }),
    ],
  };
  assert.equal(TR._cleanSegments(data), "Hola qué tal");
});

test("cleanSegments: descarta por no_speech_prob alto", () => {
  const data = { segments: [seg(0, 2, "ruido", { no_speech_prob: 0.9 }), seg(2, 4, "voz real")] };
  assert.equal(TR._cleanSegments(data), "voz real");
});

test("cleanSegments: devuelve vacío si todo es invención (el llamador cae a data.text)", () => {
  const data = { segments: [seg(0, 2, "x", { avg_logprob: -1.5 })] };
  assert.equal(TR._cleanSegments(data), "");
});

test("cleanSegments: con palabras, corta línea en las pausas largas (> WORD_GAP)", () => {
  const data = {
    segments: [seg(0, 10, "uno dos tres cuatro")],
    words: [word(0, 0.5, "uno"), word(0.6, 1, "dos"), word(3, 3.5, "tres"), word(3.6, 4, "cuatro")],
  };
  assert.equal(TR._cleanSegments(data), "uno dos\ntres cuatro");
});

test("cleanSegments: las palabras dentro de un segmento rechazado se descartan, las del hueco entre segmentos se conservan", () => {
  const data = {
    segments: [seg(0, 2, "hola"), seg(5, 7, "inventado", { avg_logprob: -1.3 })],
    words: [word(0, 1, "hola"), word(1.5, 2, "suelta"), word(5.5, 6, "inventado")],
  };
  assert.equal(TR._cleanSegments(data), "hola suelta");
});

test("toRealTime: deshace el recorte de silencios con el mapping", () => {
  // Dos tramos con voz: [0,10) del original y [30,40) del original.
  const mapping = [{ at: 0, real: 0, len: 10 }, { at: 10, real: 30, len: 10 }];
  assert.equal(TR._toRealTime(5, mapping), 5);
  assert.equal(TR._toRealTime(12, mapping), 32);
  // Más allá del último tramo: el final del original.
  assert.equal(TR._toRealTime(25, mapping), 40);
  // Sin mapping: identidad.
  assert.equal(TR._toRealTime(7, null), 7);
});

test("cleanSegments: el hueco entre palabras se mide en tiempo REAL (el silencio recortado cuenta)", () => {
  const mapping = [{ at: 0, real: 0, len: 1 }, { at: 1, real: 10, len: 1 }];
  const data = {
    segments: [seg(0, 2, "a b")],
    // En el audio subido están pegadas (0.5 y 1.2), pero en el real hay 9 s entre medio.
    words: [word(0, 0.5, "a"), word(1.2, 1.6, "b")],
  };
  assert.equal(TR._cleanSegments(data, mapping), "a\nb");
});

test("goodSegments: devuelve los segmentos buenos con tiempos reales", () => {
  const mapping = [{ at: 0, real: 100, len: 60 }];
  const data = { segments: [seg(1, 3, " hola "), seg(4, 5, "basura", { avg_logprob: -2 })] };
  assert.deepEqual(TR._goodSegments(data, mapping), [{ start: 101, end: 103, text: "hola" }]);
});

test("goodSegments: si el filtro deja todo afuera, devuelve todos los que tienen texto", () => {
  const data = { segments: [seg(0, 1, "dudoso", { avg_logprob: -2 }), seg(1, 2, "  ")] };
  assert.deepEqual(TR._goodSegments(data), [{ start: 0, end: 1, text: "dudoso" }]);
});
