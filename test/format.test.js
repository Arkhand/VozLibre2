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

test("parseCliOutput: un is_error en el sobre JSON es un fallo, aunque el exit sea 0", () => {
  const sobre = JSON.stringify({ type: "result", is_error: true, result: "API Error: 400 Claude Code 2.1.177 does not support this model" });
  const r = format._parseCliOutput(0, sobre, "");
  assert.equal(r.ok, false);
  assert.match(r.error, /does not support this model/);
  // Y nunca se toma ese texto como transcripción formateada.
  assert.equal(r.text, undefined);
});

test("parseCliOutput: exit != 0 sin stderr muestra la cola de stdout, no un mensaje vacío", () => {
  const r = format._parseCliOutput(1, "algo salió mal en stdout", "");
  assert.equal(r.ok, false);
  assert.match(r.error, /algo salió mal/);
});

test("parseCliOutput: respuesta buena", () => {
  const r = format._parseCliOutput(0, JSON.stringify({ result: "```markdown\nHola.\n```" }), "");
  assert.deepEqual(r, { ok: true, text: "Hola." });
});
