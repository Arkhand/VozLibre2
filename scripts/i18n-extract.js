/* VozLibre2 — Extractor de frases a traducir
 * ===========================================
 * Recorre el código y junta todas las claves de traducción:
 *   - llamadas t("…") en src/**\/*.js
 *   - elementos con data-i18n / data-i18n-title / data-i18n-placeholder en index.html
 * Escribe src/i18n/msgids.json (lista ordenada, sin duplicados) para que quien
 * traduzca tenga la lista completa. Uso: `npm run i18n:extract`.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

function unescapeJs(s) {
  return s.replace(/\\(["'\\nt])/g, (_, c) => ({ n: "\n", t: "\t" }[c] || c));
}

function extract() {
  const ids = new Set();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (file.endsWith(".js")) {
      // t("…") y t('…'); el primer argumento tiene que ser un literal.
      const re = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
      let m;
      while ((m = re.exec(text)) !== null) ids.add(unescapeJs(m[1] ?? m[2]));
    } else {
      // Texto plano de elementos con data-i18n (sin etiquetas adentro).
      const plain = /<(\w+)[^>]*\sdata-i18n(?:="")?(?:\s[^>]*)?>([^<]+)<\/\1>/g;
      let m;
      while ((m = plain.exec(text)) !== null) ids.add(m[2].replace(/\s+/g, " ").trim());
      // Contenido con etiquetas (data-i18n="html").
      const html = /<(\w+)[^>]*\sdata-i18n="html"[^>]*>([\s\S]*?)<\/\1>/g;
      while ((m = html.exec(text)) !== null) ids.add(m[2].replace(/\s+/g, " ").trim());
      // Atributos.
      const attrs = /(?:title|placeholder)="([^"]+)"[^>]*\sdata-i18n-(?:title|placeholder)|\sdata-i18n-(?:title|placeholder)[^>]*(?:title|placeholder)="([^"]+)"/g;
      while ((m = attrs.exec(text)) !== null) ids.add(m[1] || m[2]);
    }
  }
  return [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b, "es"));
}

if (require.main === module) {
  const ids = extract();
  const out = path.join(SRC, "i18n", "msgids.json");
  fs.writeFileSync(out, JSON.stringify(ids, null, 2) + "\n", "utf8");
  console.log(`${ids.length} frases -> ${path.relative(process.cwd(), out)}`);
}

module.exports = { extract };
