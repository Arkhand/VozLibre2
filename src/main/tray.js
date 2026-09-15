/* VozLibre2 — Icono de bandeja (system tray)
 * ===========================================
 * La ✕ de la píldora ya no cierra la app: la oculta al tray. Desde acá se vuelve a
 * mostrar (clic en el icono o "Mostrar") y se sale de verdad ("Salir").
 * El icono vive en assets/icon.ico (incluido en el build vía package.json > files).
 *
 * También muestra el AVANCE de los trabajos largos: con la píldora escondida, el
 * tooltip del icono es la única forma de ver en qué anda una reunión o un archivo
 * de una hora, y al terminar avisa con un globo (sin robar el foco).
 */

const { app, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const windowMod = require("./window");

let tray = null;
// Guardado para poder usarlo en el globo de aviso (Windows lo pide).
let trayImage = null;

// Tooltip base (sin trabajo en curso).
function baseTip() { return `VozLibre ${app.getVersion()}`; }

/* Avance en el tooltip del icono. text viene armado por el renderer
 * (VLProgress.trayText): "Transcribiendo parte 3 de 12… · 25 % · 04:12".
 * Windows corta los tooltips largos, así que se recorta antes de que lo haga él. */
function setJob(text) {
  if (!tray) return;
  const linea = String(text || "").trim();
  tray.setToolTip(linea ? `${baseTip()}\n${linea}`.slice(0, 127) : baseTip());
}

/* Trabajo terminado. Si la píldora está escondida, el globo de Windows es lo
 * único que avisa; con la píldora a la vista el mensaje ya está en la barra y un
 * globo encima sería ruido. */
function notifyDone(msg) {
  if (!tray) return;
  setJob("");
  if (!msg || windowMod.isVisible()) return;
  try {
    tray.displayBalloon({
      title: "VozLibre",
      content: msg,
      icon: trayImage || undefined,
    });
  } catch (e) {
    // displayBalloon es de Windows; en otras plataformas (o sin soporte) no pasa nada.
    console.log(`tray: no se pudo mostrar el aviso (${e.message})`);
  }
}

function create() {
  if (tray) return tray;

  // assets/ está en la raíz del proyecto; este módulo vive en src/main/.
  const iconPath = path.join(__dirname, "..", "..", "assets", "icon.ico");
  const image = nativeImage.createFromPath(iconPath);

  trayImage = image.isEmpty() ? nativeImage.createEmpty() : image;
  tray = new Tray(trayImage);
  tray.setToolTip(baseTip());

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
  trayImage = null;
}

module.exports = { create, destroy, setJob, notifyDone };
