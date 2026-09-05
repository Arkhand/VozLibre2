const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const i18n = require("../src/i18n/i18n");
const { extract } = require("../scripts/i18n-extract");

test("t: en español la clave es la frase (identidad) y se interpolan parámetros", () => {
  assert.equal(i18n.t("Grabando…"), "Grabando…");
  assert.equal(i18n.t("Parte {i} de {n}", { i: 2, n: 5 }), "Parte 2 de 5");
  // Parámetro ausente: se deja la llave visible en vez de romper.
  assert.equal(i18n.t("Hola {x}", {}), "Hola {x}");
});

test("t: con otro idioma usa el diccionario y cae al español si falta la frase", () => {
  i18n.LOCALES.xx = { "Grabando…": "Recording…" };
  i18n.setLang("xx");
  assert.equal(i18n.t("Grabando…"), "Recording…");
  assert.equal(i18n.t("Sin traducir"), "Sin traducir");
  assert.equal(i18n.setLang("zz"), "es"); // idioma desconocido: vuelve al default
  delete i18n.LOCALES.xx;
});

test("extractor: encuentra las frases de t() y del HTML", () => {
  const ids = extract();
  assert.ok(ids.length > 150, `solo ${ids.length} frases`);
  assert.ok(ids.includes("Grabando… soltá para transcribir"));          // t() en transcription.js
  assert.ok(ids.includes("Modelo de transcripción"));                    // data-i18n en index.html
  assert.ok(ids.includes("Hacé clic y presioná la combinación"));        // data-i18n-placeholder
  assert.ok(ids.includes("Mantené para grabar"));                        // data-i18n-title
});

test("el i18n no depende de electron ni del DOM", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "src", "i18n", "i18n.js"), "utf8");
  assert.ok(!/require\("electron"\)/.test(src));
});
