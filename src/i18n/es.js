/* VozLibre2 — Diccionario: español (idioma base)
 * ================================================
 * Las CLAVES de traducción son las frases en español tal como aparecen en el
 * código, así que este diccionario no necesita entradas: t("x") devuelve "x".
 *
 * Sirve de plantilla para otros idiomas. Para inglés, por ejemplo, copiar este
 * archivo a en.js y llenar el objeto así:
 *
 *   "Grabando… soltá para transcribir": "Recording… release to transcribe",
 *   "Parte {i} de {n}": "Part {i} of {n}",
 *
 * Los {parámetros} se conservan tal cual. Para obtener la lista completa de frases
 * a traducir: `npm run i18n:extract` genera src/i18n/msgids.json.
 */
(function (root, strings) {
  if (typeof module === "object" && module.exports) module.exports = strings;
  else (root.VL_LOCALES = root.VL_LOCALES || {}).es = strings;
})(typeof globalThis !== "undefined" ? globalThis : this, {
  // vacío a propósito: español es el idioma de las claves
});
