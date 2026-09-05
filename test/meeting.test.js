const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRendererModule } = require("./helpers");

const MT = loadRendererModule("meeting.js", "VLMeeting");

const L = (start, text) => ({ start, end: start, text });

test("merge: intercala las dos pistas por tiempo real, no por pista", () => {
  const out = MT.merge({
    sistema: [L(0, "Hola, ¿cómo andan?"), L(12, "Perfecto, arranquemos.")],
    mic: [L(5, "Bien, todo en orden por acá.")],
  });
  assert.deepEqual(out.map((s) => `${s.speaker}: ${s.text}`), [
    "Reunión: Hola, ¿cómo andan?",
    "Yo: Bien, todo en orden por acá.",
    "Reunión: Perfecto, arranquemos.",
  ]);
});

test("merge: el eco (misma frase en la otra pista dentro de 2 s, 4+ palabras) se descarta", () => {
  const out = MT.merge({
    sistema: [L(10, "Vamos a revisar el presupuesto del trimestre")],
    mic: [L(10.8, "vamos a revisar el presupuesto del trimestre")],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].speaker, "Reunión");
});

test("merge: la misma frase lejos en el tiempo NO es eco (con tiempos reales por frase)", () => {
  // Antes todas las frases de un trozo compartían el tiempo del trozo y esto se
  // descartaba como eco aunque hubieran pasado minutos.
  const out = MT.merge({
    sistema: [L(10, "Vamos a revisar el presupuesto del trimestre")],
    mic: [L(200, "vamos a revisar el presupuesto del trimestre")],
  });
  assert.equal(out.length, 2);
});

test("merge: las frases cortas nunca se descartan como eco", () => {
  const out = MT.merge({
    sistema: [L(10, "sí dale")],
    mic: [L(10.5, "sí dale")],
  });
  assert.equal(out.length, 2);
});

test("merge: repetición exacta consecutiva de la misma pista es duplicado", () => {
  const out = MT.merge({ sistema: [L(1, "hola"), L(1.5, "hola")], mic: [] });
  assert.equal(out.length, 1);
});

test("render: marca de tiempo y hablante por línea", () => {
  const txt = MT.render([{ t: 65, speaker: "Yo", text: "hola" }, { t: 3700, speaker: "Reunión", text: "chau" }]);
  assert.equal(txt, "[01:05] Yo: hola\n[01:01:40] Reunión: chau");
});
