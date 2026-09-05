/* VozLibre2 — Aviso de versión nueva
 * ===================================
 * Consulta la última release del repo público de GitHub y la compara con la
 * versión de la app. No descarga ni instala nada: avisa y da el link. En un
 * portable sin firma, auto-actualizar solo generaría más alarmas de SmartScreen.
 *
 * El repo sale de package.json > repository. Las releases tienen que estar
 * etiquetadas con la versión (v1.2.3 o 1.2.3) y llevar el .exe como asset.
 * `npm run dist` sube el patch de package.json en cada build, así que cada .exe
 * que se publique tiene una versión distinta y comparable.
 */

const pkg = require("../../package.json");

const TIMEOUT_MS = 8000;

function repoFromPackage() {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : (r && r.url) || "";
  // Acepta "github:owner/repo", "owner/repo", y URLs https/git.
  const m = /(?:github\.com[/:]|github:|^)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// ¿`remote` es más nueva que `local`? Solo compara mayor.menor.patch.
function isNewer(remote, local) {
  const a = parseVersion(remote), b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function currentVersion() {
  try { return require("electron").app.getVersion(); } catch { return pkg.version; }
}

/* Devuelve { ok, current, latest, available, url, downloadUrl } o { ok:false, error }.
 * Sin releases publicadas (404) devuelve ok:true con available:false. */
async function check() {
  const repo = repoFromPackage();
  const current = currentVersion();
  if (!repo) return { ok: false, error: "package.json sin repository" };

  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `VozLibre2/${current}` },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { ok: true, current, latest: null, available: false };
    if (!res.ok) return { ok: false, error: `GitHub HTTP ${res.status}` };
    const j = await res.json();
    const latest = String(j.tag_name || j.name || "").replace(/^v/i, "");
    const exe = (j.assets || []).find((a) => /\.exe$/i.test(a.name || ""));
    return {
      ok: true,
      current,
      latest,
      available: isNewer(latest, current),
      url: j.html_url || `https://github.com/${repo.owner}/${repo.repo}/releases/latest`,
      downloadUrl: (exe && exe.browser_download_url) || j.html_url,
    };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check, isNewer, parseVersion, repoFromPackage, currentVersion };
