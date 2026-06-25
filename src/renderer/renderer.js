/* VozLibre2 — Renderer (UI de la pildora)
 * =======================================
 * Grabacion (MediaRecorder) -> Groq Whisper -> accion configurada (mostrar /
 * pegar / teclear). Estado COLAPSADO en reposo; expande al grabar/transcribir o
 * al abrir config. La config se persiste via window.pill.saveSettings.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MODEL = "whisper-large-v3";

// ----- DOM -----
const pillEl    = document.getElementById("pill");
const recBtn    = document.getElementById("recBtn");
const configBtn = document.getElementById("configBtn");
const closeBtn  = document.getElementById("closeBtn");
const barCenter = document.getElementById("barCenter");
const statusEl  = document.getElementById("status");
const timer     = document.getElementById("timer");
const result    = document.getElementById("result");
const copyBtn   = document.getElementById("copyBtn");
const clearBtn  = document.getElementById("clearBtn");
const errEl     = document.getElementById("err");

// Config
const cfgApiKey   = document.getElementById("cfgApiKey");
const cfgMic      = document.getElementById("cfgMic");
const cfgLang     = document.getElementById("cfgLang");
const cfgAction   = document.getElementById("cfgAction");
const cfgShortcut = document.getElementById("cfgShortcut");
const cfgSave     = document.getElementById("cfgSave");
const cfgSaved    = document.getElementById("cfgSaved");
const cfgTest     = document.getElementById("cfgTest");

// ----- Estado -----
let settings = {};
let mediaRecorder = null;
let chunks = [];
let stream = null;
let isRecording = false;
let timerId = null;
let startTime = 0;
let configOpen = false;

// ---------------------------------------------------------------------------
// Ventana: medir alto y pedir a Electron el resize.
// ---------------------------------------------------------------------------
function syncWindowHeight() {
  const h = Math.ceil(pillEl.getBoundingClientRect().height) + 12; // +12 por el margin (6px×2)
  window.pill?.resize(h);
}

function refreshLayout() {
  // Hay centro (status) si grabamos o hay texto de estado.
  const showCenter = isRecording || statusEl.textContent.trim() !== "";
  barCenter.classList.toggle("show", showCenter);
  requestAnimationFrame(syncWindowHeight);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function fmt(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}
function startTimer() {
  startTime = performance.now();
  timer.classList.add("live");
  timer.textContent = "00:00";
  timerId = setInterval(() => { timer.textContent = fmt(performance.now() - startTime); }, 200);
}
function stopTimer() {
  clearInterval(timerId);
  timerId = null;
  timer.classList.remove("live");
}
function setStatus(msg) { statusEl.textContent = msg || ""; refreshLayout(); }
function setError(msg) {
  errEl.textContent = msg || "";
  if (msg) pillEl.classList.add("has-result");
  refreshLayout();
}
function setResult(text) {
  if (text && text.trim()) {
    result.textContent = text.trim();
    result.classList.remove("empty");
    copyBtn.disabled = false;
    clearBtn.disabled = false;
    pillEl.classList.add("has-result");
  } else {
    result.textContent = "El texto transcripto aparecerá acá…";
    result.classList.add("empty");
    copyBtn.disabled = true;
    clearBtn.disabled = true;
    errEl.textContent = "";
    pillEl.classList.remove("has-result");
  }
  refreshLayout();
}

// ---------------------------------------------------------------------------
// Config: cargar/guardar, micrófonos, captura de atajo.
// ---------------------------------------------------------------------------
async function loadConfigIntoUI() {
  settings = await window.pill.loadSettings();
  cfgApiKey.value   = settings.groqApiKey || "";
  cfgLang.value     = settings.lang ?? "es";
  cfgAction.value   = settings.action || "show";
  cfgShortcut.value = settings.shortcut || "";
  await populateMics();
  cfgMic.value = settings.deviceId || "";
}

async function populateMics() {
  try {
    // Necesitamos permiso para ver labels de los dispositivos.
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    cfgMic.innerHTML = '<option value="">Por defecto del sistema</option>';
    mics.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Micrófono ${i + 1}`;
      cfgMic.appendChild(opt);
    });
  } catch (e) {
    // si falla, queda solo "por defecto"
  }
}

async function saveConfig() {
  const next = {
    groqApiKey: cfgApiKey.value.trim(),
    lang: cfgLang.value,
    deviceId: cfgMic.value,
    action: cfgAction.value,
    shortcut: cfgShortcut.value,
  };
  settings = await window.pill.saveSettings(next);
  // Soltar el stream actual para que el próximo use el micrófono nuevo.
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  cfgSaved.textContent = "✓ Guardado";
  cfgSaved.classList.add("show");
  setTimeout(() => cfgSaved.classList.remove("show"), 1600);
}

// Captura de combinación de teclas para el atajo (formato acelerador de Electron).
function setupShortcutCapture() {
  cfgShortcut.addEventListener("keydown", (e) => {
    e.preventDefault();
    const mods = [];
    if (e.ctrlKey)  mods.push("Control");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey)   mods.push("Alt");
    if (e.metaKey)  mods.push("Super");
    const key = e.key;
    // Ignorar pulsar solo un modificador.
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
      cfgShortcut.value = mods.join("+") + "+…";
      return;
    }
    let main = key.length === 1 ? key.toUpperCase() : key;
    if (key === " ") main = "Space";
    cfgShortcut.value = [...mods, main].join("+");
  });
}

function toggleConfig() {
  configOpen = !configOpen;
  pillEl.classList.toggle("config-open", configOpen);
  configBtn.classList.toggle("active", configOpen);
  // Solo mientras la config está abierta la pildora puede tomar foco (para escribir
  // la API key, etc.). Al cerrarla, vuelve a no-robar-foco.
  window.pill.setFocusable(configOpen);
  if (configOpen) loadConfigIntoUI();
  refreshLayout();
}

// ---------------------------------------------------------------------------
// Grabación + transcripción
// ---------------------------------------------------------------------------
async function getStream() {
  if (stream) return stream;
  const constraints = settings.deviceId
    ? { audio: { deviceId: { exact: settings.deviceId } } }
    : { audio: true };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  return stream;
}

async function startRecording() {
  if (isRecording) return;
  setError("");
  if (!settings.groqApiKey) {
    pillEl.classList.add("has-result");
    setError("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala.");
    return;
  }
  try {
    const s = await getStream();
    chunks = [];
    mediaRecorder = new MediaRecorder(s);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = handleStop;
    mediaRecorder.start();
    isRecording = true;
    recBtn.classList.add("recording");
    setStatus("Grabando… soltá para transcribir");
    startTimer();
  } catch (e) {
    setError("Sin micrófono: " + e.message);
  }
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  stopTimer();
  recBtn.classList.remove("recording");
  setStatus("Procesando…");
  mediaRecorder.stop();
}

async function handleStop() {
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
  if (blob.size === 0) {
    setStatus("");
    setError("No se grabó audio. Probá de nuevo.");
    return;
  }
  await transcribe(blob);
}

async function transcribe(blob) {
  recBtn.disabled = true;
  setStatus("Transcribiendo con Groq…");
  setError("");
  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", blob, "audio." + ext);
  form.append("model", MODEL);
  form.append("response_format", "json");
  if (settings.lang) form.append("language", settings.lang);

  try {
    const res = await fetch(GROQ_BASE_URL + "/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + settings.groqApiKey },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error("HTTP " + res.status + " — " + detail);
    }
    const data = await res.json();
    const text = (data.text || "").trim();
    await applyAction(text);
  } catch (e) {
    setError("Error: " + e.message);
    setStatus("");
  } finally {
    recBtn.disabled = false;
  }
}

// Aplica la acción configurada al texto reconocido.
async function applyAction(text) {
  if (!text) { setStatus(""); setError("No se reconoció texto."); return; }
  const action = settings.action || "show";

  // Siempre mostramos el texto (referencia visual).
  setResult(text);

  if (action === "show") {
    setStatus("Listo.");
    return;
  }
  if (action === "paste") {
    const r = await window.pill.paste(text);
    setStatus(r?.ok ? "Pegado (Ctrl+V) ✓" : "No se pudo pegar");
    if (!r?.ok) setError(r?.error || "Error al pegar");
    return;
  }
  if (action === "type") {
    setStatus("Tecleando…");
    const r = await window.pill.type(text);
    setStatus(r?.ok ? "Tecleado ✓" : "No se pudo teclear");
    if (!r?.ok) setError(r?.error || "Error al teclear");
    return;
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
recBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRecording(); });
recBtn.addEventListener("pointerup",   (e) => { e.preventDefault(); stopRecording(); });
recBtn.addEventListener("pointerleave", () => { if (isRecording) stopRecording(); });
recBtn.addEventListener("contextmenu", (e) => e.preventDefault());

configBtn.addEventListener("click", toggleConfig);
closeBtn.addEventListener("click", () => window.pill?.close());
cfgSave.addEventListener("click", saveConfig);

// Modo prueba: dispara la acción elegida con texto fijo (sin gastar API).
cfgTest.addEventListener("click", async () => {
  const action = cfgAction.value; // "show" | "paste" | "type"
  if (action === "show") {
    setResult("Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123");
    setStatus('Acción "Solo mostrar": el texto aparece acá ✓');
    return;
  }
  // Cerramos la config para soltar el foco y que el tecleo caiga en tu app.
  if (configOpen) toggleConfig();
  cfgTest.disabled = true;
  setStatus("Enfocá tu app… (1,5 s)");
  const r = await window.pill.testAction(action);
  cfgTest.disabled = false;
  if (r?.ok) setStatus(action === "paste" ? "Pegado (Ctrl+V) ✓" : "Tecleado ✓");
  else { pillEl.classList.add("has-result"); setError("Falló: " + (r?.error || "desconocido")); }
});

copyBtn.addEventListener("click", async () => {
  await window.pill.copyToClipboard(result.textContent);
  const orig = copyBtn.textContent;
  copyBtn.textContent = "✅ Copiado";
  setTimeout(() => { copyBtn.textContent = orig; }, 1400);
});
clearBtn.addEventListener("click", () => { setResult(""); setStatus(""); });

// Atajo global PUSH-TO-TALK: mantener presionado = grabar, soltar = transcribir.
window.pill.onPttDown(() => { if (!isRecording) startRecording(); });
window.pill.onPttUp(() => { if (isRecording) stopRecording(); });

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  setupShortcutCapture();
  settings = await window.pill.loadSettings();
  refreshLayout();
});
