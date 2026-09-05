const test = require("node:test");
const assert = require("node:assert/strict");

const format = require("../src/main/format");

test("markPauses: inserta ⏸ en el corte de frase más cercano a la pausa real", () => {
  const text = "Primera frase. Segunda frase. Tercera frase.";
  // Pausa de 2 s al 68% del chunk: en el texto eso cae justo en el segundo punto.
  const out = format._markPauses(text, 0, 100, [{ start: 68, end: 70 }]);
  assert.equal(out, "Primera frase. Segunda frase. ⏸ Tercera frase.");
});

test("markPauses: si el corte de frase más cercano queda lejos (>10% del texto), no fuerza la marca", () => {
  const text = "Primera frase. Segunda frase. Tercera frase.";
  const out = format._markPauses(text, 0, 100, [{ start: 50, end: 52 }]);
  assert.equal(out, text);
});

test("markPauses: ignora pausas cortas y las de otro chunk", () => {
  const text = "Una. Dos. Tres.";
  assert.equal(format._markPauses(text, 0, 100, [{ start: 50, end: 50.5 }]), text);
  assert.equal(format._markPauses(text, 0, 100, [{ start: 150, end: 160 }]), text);
});

test("markPauses: sin cortes de frase no fuerza nada", () => {
  const text = "un choclo sin puntuación de ningún tipo";
  assert.equal(format._markPauses(text, 0, 100, [{ start: 50, end: 55 }]), text);
});

test("splitForCalls: corta en fin de frase sin partir palabras", () => {
  const frase = "Esta es una frase de prueba. ";
  const text = frase.repeat(600); // ~17k caracteres
  const parts = format._splitForCalls(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= 12000);
    assert.ok(p.endsWith("."), `parte termina en: …${p.slice(-10)}`);
  }
  assert.equal(parts.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
});

test("stripFences: saca los ```markdown que el modelo mete a veces", () => {
  assert.equal(format._stripFences("```markdown\nhola\n```"), "hola");
  assert.equal(format._stripFences("```\nhola\n```"), "hola");
  assert.equal(format._stripFences("hola"), "hola");
});

test("unwrap: desenvuelve {result} del CLI y cae al crudo si no es JSON", () => {
  assert.equal(format._unwrap('{"result":"```md\\ntexto\\n```"}'), "texto");
  assert.equal(format._unwrap("no json"), "no json");
});

test("stamp: mm:ss y hh:mm:ss", () => {
  assert.equal(format.stamp(65), "01:05");
  assert.equal(format.stamp(3661), "01:01:01");
});
