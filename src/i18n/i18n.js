/* VozLibre2 — Internacionalización (estilo gettext)
 * ==================================================
 * Un solo módulo para el main (require) y el renderer (script tag → window.VLI18n).
 *
 * Cómo funciona: el texto en ESPAÑOL es la clave. `t("Grabando…")` devuelve
 * "Grabando…" en español y, con otro idioma activo, lo que diga su diccionario.
 * Si una frase no está traducida, sale en español (nunca una clave vacía).
 *
 * Por qué el texto como clave y no ids ("ui.recording"): con 250 frases, mantener
 * ids a mano es la fuente número uno de "texto que no aparece". Con el texto como
 * clave no hay ids que inventar ni desincronizar, y el código sigue legible.
 *
 * Parámetros: `t("Parte {i} de {n}", { i: 2, n: 5 })` reemplaza {i} y {n}.
 *
 * Para agregar un idioma:
 *   1. Copiar es.js a en.js y traducir los valores (las claves quedan en español).
 *   2. Registrarlo abajo en LOCALES (main) y cargarlo en index.html (renderer).
 *   3. Elegirlo con setLang("en") — el setting `uiLang` está previsto para eso.
 *
 * En HTML se marcan los elementos con `data-i18n` (texto), `data-i18n="html"`
 * (contenido con etiquetas), `data-i18n-title` y `data-i18n-placeholder`; apply()
 * los traduce en el arranque usando el contenido actual como clave.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ es: require("./es") });
  } else {
    root.VLI18n = factory(root.VL_LOCALES || {});
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (LOCALES) {
  const DEFAULT_LANG = "es";
  let lang = DEFAULT_LANG;

  function available() { return Object.keys(LOCALES); }

  function setLang(l) {
    lang = LOCALES[l] ? l : DEFAULT_LANG;
    return lang;
  }
  function getLang() { return lang; }

  function interpolate(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }

  // Traduce una frase. Español = identidad (la clave ES la frase).
  function t(msgid, params) {
    const dict = LOCALES[lang];
    const s = (dict && typeof dict[msgid] === "string" && dict[msgid]) || msgid;
    return interpolate(s, params);
  }

  // Traduce los elementos marcados del DOM. Idempotente en español.
  function apply(rootEl) {
    if (typeof document === "undefined") return;
    const scope = rootEl || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      if (el.getAttribute("data-i18n") === "html") {
        const key = el.innerHTML.trim();
        const out = t(key);
        if (out !== key) el.innerHTML = out;
      } else {
        const key = el.textContent.trim();
        const out = t(key);
        if (out !== key) el.textContent = out;
      }
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.title); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.placeholder); });
  }

  return { t, setLang, getLang, apply, available, DEFAULT_LANG, LOCALES };
});
