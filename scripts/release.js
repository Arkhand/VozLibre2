/* VozLibre2 — Publicar una release en GitHub
 * ===========================================
 * `npm run dist` solo compila. Este script sube el .exe de dist/ como release
 * pública del repo (package.json > repository) con el tag v<versión>, que es lo
 * que el chequeo de actualizaciones de la app compara.
 *
 * Uso:  npm run release            (después de npm run dist)
 *       npm run release -- --dirty (permite árbol de git con cambios sin commitear)
 *
 * Requiere el CLI de GitHub (`gh`) autenticado: https://cli.github.com
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const version = pkg.version;
const tag = `v${version}`;
const exe = path.join(root, "dist", `VozLibre2-${version}-portable.exe`);
const allowDirty = process.argv.includes("--dirty");

function repo() {
  const r = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
  const m = /(?:github\.com[/:]|github:|^)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r.trim());
  if (!m) throw new Error("package.json > repository no apunta a GitHub");
  return `${m[1]}/${m[2]}`;
}
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function fail(msg) { console.error(`✖ ${msg}`); process.exit(1); }

// 1. El .exe de ESTA versión tiene que existir.
if (!fs.existsSync(exe)) fail(`No existe ${path.relative(root, exe)}. Corré \`npm run dist\` primero.`);

// 2. gh instalado y logueado.
if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
  fail("El CLI de GitHub no está instalado o no está logueado (gh auth login).");
}

// 2b. Con varias cuentas en gh, la activa puede no ser la dueña del repo. Si el
//     owner está logueado, se usa SU token para esta corrida (GH_TOKEN), sin
//     cambiar la cuenta activa.
const owner = repo().split("/")[0];
const tok = spawnSync("gh", ["auth", "token", "--user", owner], { encoding: "utf8" });
const env = { ...process.env };
if (tok.status === 0 && tok.stdout.trim()) {
  env.GH_TOKEN = tok.stdout.trim();
  console.log(`Usando la cuenta ${owner} de gh para publicar.`);
}

// 3. Publicar código que no está en el repo es la receta para "me anda raro":
//    la release lleva notas generadas de los commits y el tag apunta al HEAD remoto.
const dirty = git(["status", "--porcelain"]);
if (dirty && !allowDirty) {
  fail("Hay cambios sin commitear. Commiteá y pusheá primero (o pasá --dirty si sabés lo que hacés).");
}
try {
  git(["fetch", "-q", "origin"]);
  const ahead = git(["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead !== "0" && !allowDirty) fail(`Hay ${ahead} commit(s) sin pushear. Hacé git push primero.`);
} catch { console.warn("⚠ No se pudo comparar con origin; sigo igual."); }

// 4. Que no exista ya la release (subir dos veces la misma versión es un error de flujo).
const exists = spawnSync("gh", ["release", "view", tag, "-R", repo()], { stdio: "ignore", env }).status === 0;
if (exists) fail(`La release ${tag} ya existe en ${repo()}. Subí la versión (npm run dist) o borrala en GitHub.`);

console.log(`Publicando ${tag} en ${repo()} con ${path.basename(exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)…`);
execFileSync("gh", [
  "release", "create", tag, exe,
  "-R", repo(),
  "--title", `VozLibre2 ${version}`,
  "--generate-notes",
], { stdio: "inherit", env });
console.log(`✓ Release ${tag} publicada. La app va a avisar de esta versión a quien tenga una anterior.`);
