const test = require("node:test");
const assert = require("node:assert/strict");

const audio = require("../src/main/audio");

test("planCutPoints: no corta si el audio entra en un trozo", () => {
  assert.deepEqual(audio._planCutPoints(500, [], 600), []);
});

test("planCutPoints: reparte parejo en vez de llenar y dejar una cola", () => {
  // 33.8 min con tope de 30 -> 2 partes de ~17 min, no 30 + 3.8.
  const cuts = audio._planCutPoints(33.8 * 60, [], 30 * 60);
  assert.equal(cuts.length, 1);
  assert.ok(Math.abs(cuts[0] - 16.9 * 60) < 1, `corte en ${cuts[0]}`);
});

test("planCutPoints: prefiere el silencio cercano al punto ideal", () => {
  // 1000 s con tope 600 -> 2 partes, ideal en 500. La ventana de búsqueda queda
  // acotada por el tope: [410, 590].
  const silences = [{ start: 490, end: 492 }, { start: 700, end: 701 }];
  const cuts = audio._planCutPoints(1000, silences, 600);
  assert.deepEqual(cuts, [491]); // el medio de la pausa cercana al ideal
});

test("planCutPoints: entre pausas cercanas gana la más larga", () => {
  const silences = [{ start: 498, end: 498.5 }, { start: 510, end: 513 }];
  const cuts = audio._planCutPoints(1000, silences, 600);
  assert.deepEqual(cuts, [511.5]);
});

test("planCutPoints: con el audio justo en 2x el tope no hay margen y corta seco en la mitad", () => {
  assert.deepEqual(audio._planCutPoints(1200, [{ start: 590, end: 592 }], 600), [600]);
});

test("planCutPoints: ninguna parte supera el tope aunque no haya silencios", () => {
  const cuts = audio._planCutPoints(1850, [], 600);
  const bounds = [0, ...cuts, 1850];
  for (let i = 1; i < bounds.length; i++) {
    assert.ok(bounds[i] - bounds[i - 1] <= 600 + 1e-6, `parte ${i} mide ${bounds[i] - bounds[i - 1]}`);
  }
});

test("voicedSpans: sin silencios largos, todo es voz", () => {
  assert.deepEqual(audio._voicedSpans(100, [{ start: 10, end: 11 }]), [{ start: 0, end: 100 }]);
});

test("voicedSpans: recorta un silencio largo dejando colchón a cada lado", () => {
  const spans = audio._voicedSpans(100, [{ start: 40, end: 50 }]);
  assert.deepEqual(spans, [{ start: 0, end: 40.4 }, { start: 49.6, end: 100 }]);
});

test("voicedSpans: un silencio al principio no deja un tramo de puro silencio", () => {
  const spans = audio._voicedSpans(100, [{ start: 0, end: 9 }]);
  assert.deepEqual(spans, [{ start: 8.6, end: 100 }]);
});

test("voicedSpans: un silencio hasta el final cierra ahí", () => {
  const spans = audio._voicedSpans(100, [{ start: 90, end: 100 }]);
  assert.deepEqual(spans, [{ start: 0, end: 90.4 }]);
});

test("chunkSecondsFrom: acota la config a [1, 30] minutos", () => {
  assert.equal(audio.chunkSecondsFrom(0), audio.CHUNK_SECONDS);
  assert.equal(audio.chunkSecondsFrom(0.2), 60);
  assert.equal(audio.chunkSecondsFrom(45), 1800);
  assert.equal(audio.chunkSecondsFrom(10), 600);
});
