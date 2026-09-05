const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRendererModule } = require("./helpers");

const TR = loadRendererModule("transcription.js", "VLTranscription");
const msg = TR._apiErrorMessage;

test("401: key inválida, en castellano y sin volcar el JSON de Groq", () => {
  const m = msg(401, '{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}');
  assert.match(m, /API key/);
  assert.match(m, /⚙/);
  assert.doesNotMatch(m, /invalid_request_error/);
});

test("429 y 5xx: mensajes accionables", () => {
  assert.match(msg(429, ""), /cuota/i);
  assert.match(msg(503, ""), /503/);
  assert.match(msg(503, ""), /minutos/);
});

test("413: tamaño máximo", () => {
  assert.match(msg(413, ""), /25 MB/);
});

test("400: incluye el detalle de Groq (es un error nuestro, sirve verlo)", () => {
  assert.match(msg(400, '{"error":{"message":"unsupported file format"}}'), /unsupported file format/);
});

test("otro código con cuerpo no-JSON: recorta y no explota", () => {
  const m = msg(418, "<html>\n  soy una tetera\n</html>");
  assert.match(m, /418/);
  assert.match(m, /soy una tetera/);
});
