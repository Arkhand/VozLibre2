const test = require("node:test");
const assert = require("node:assert/strict");

// history.js requiere electron, pero en Node `require("electron")` devuelve la
// ruta del binario sin explotar; app/shell solo se usan dentro de funciones.
const history = require("../src/main/history");

const md = (warn, body) =>
  `---\ntitulo: x\narchivo: x.mp3\nfecha: 2026-09-07\nformateado: false\n---\n\n# Reunión 7/9\n\n_x.mp3 — 12m 03s — Español_\n${warn}\n${body}\n`;

test("extractBody: saca frontmatter, título, subtítulo y el aviso de 'sin formatear'", () => {
  const src = md("\n> ⚠️ Sin formatear: Claude CLI falló.\n> El texto está tal cual lo devolvió la transcripción.\n", "hola qué tal\ntodo bien");
  assert.equal(history.extractBody(src), "hola qué tal\ntodo bien");
});

test("extractBody: sin aviso, deja el cuerpo intacto (incluidos sus propios saltos)", () => {
  const src = md("", "[00:01] Yo: hola\n[00:03] Reunión: qué tal");
  assert.equal(history.extractBody(src), "[00:01] Yo: hola\n[00:03] Reunión: qué tal");
});

test("extractBody: un blockquote DENTRO del texto no se pierde (solo se saltan los avisos iniciales)", () => {
  const src = md("\n> 📝 Texto crudo.\n", "primera línea\n> cita del usuario\nfin");
  assert.equal(history.extractBody(src), "primera línea\n> cita del usuario\nfin");
});

test("extractBody: texto que no es nuestro .md vuelve tal cual", () => {
  assert.equal(history.extractBody("solo texto"), "solo texto");
});
