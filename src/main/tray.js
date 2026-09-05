/* VozLibre2 — Icono de bandeja (system tray)
 * ===========================================
 * La ✕ de la píldora ya no cierra la app: la oculta al tray. Desde acá se vuelve a
 * mostrar (clic en el icono o "Mostrar") y se sale de verdad ("Salir").
 * El icono vive en assets/icon.ico (incluido en el build vía package.json > files).
 */

const { app, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const windowMod = require("./window");

let tray = null;

function create() {
  if (tray) return tray;

  // assets/ está en la raíz del proyecto; este módulo vive en src/main/.
  const iconPath = path.join(__dirname, "..", "..", "assets", "icon.ico");
  const image = nativeImage.createFromPath(iconPath);

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(`VozLibre ${app.getVersion()}`);

  const menu = Menu.buildFromTemplate([
    { label: "Mostrar VozLibre", click: () => windowMod.reveal() },
    { type: "separator" },
    {
      label: "Salir",
      click: () => {
        // Marca de cierre real: el handler de "close-to-tray" lo respeta.
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // Clic (o doble clic) en el icono: alterna mostrar/ocultar la píldora.
  const toggle = () => {
    if (windowMod.isVisible()) windowMod.hide();
    else windowMod.reveal();
  };
  tray.on("click", toggle);
  tray.on("double-click", () => windowMod.reveal());

  return tray;
}

function destroy() {
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { create, destroy };
