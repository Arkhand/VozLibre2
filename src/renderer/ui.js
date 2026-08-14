/* VozLibre2 — UI de la píldora (DOM, estados, layout, panel de config)
 * ====================================================================
 * Todo lo visual: referencias al DOM, estados (status/error/resultado), expansión
 * de la píldora, panel de configuración y captura de atajos. NO graba ni llama a la
 * API: dispara callbacks que conecta el orquestador (renderer.js).
 * Se expone como window.VLUI (sin require, por contextIsolation).
 */
(function () {
  // ----- DOM -----
  const $ = (id) => document.getElementById(id);
  const el = {
    pill: $("pill"), recBtn: $("recBtn"), configBtn: $("configBtn"), closeBtn: $("closeBtn"),
    fileBtn: $("fileBtn"),
    barCenter: $("barCenter"), status: $("status"), timer: $("timer"),
    result: $("result"), copyBtn: $("copyBtn"), clearBtn: $("clearBtn"), err: $("err"),
    // Config
    cfgApiKey: $("cfgApiKey"), cfgMic: $("cfgMic"), cfgLang: $("cfgLang"), cfgAction: $("cfgAction"),
    cfgShortcut: $("cfgShortcut"), cfgShortcutTranslate: $("cfgShortcutTranslate"),
    cfgSave: $("cfgSave"), cfgSaved: $("cfgSaved"), cfgTest: $("cfgTest"),
    configPanel: $("configPanel"),
    // Confirmación "salir sin guardar"
    cfgConfirm: $("cfgConfirm"), cfgConfirmCancel: $("cfgConfirmCancel"),
    cfgConfirmDiscard: $("cfgConfirmDiscard"),
  };

  let configOpen = false;
  // ¿Hay cambios en el formulario de config sin guardar?
  let dirty = false;
  let timerId = null, startTime = 0;
  // Binds capturados (formato uiohook {keycode,ctrl,shift,alt,meta}); se guardan tal cual.
  let bindTranscribe = null, bindTranslate = null;

  // Callbacks que provee el orquestador (renderer.js).
  let cb = {
    onRecordStart: () => {},   // (mode) usuario mantiene el orbe
    onRecordStop: () => {},
    onSaveConfig: () => {},     // (settingsObj) guardar config
    onConfigOpen: () => {},     // (bool) abrir/cerrar config (foco, atajos)
    onTest: () => {},           // (action) probar acción
    onCopy: () => {},           // (text)
    onPickFile: () => {},       // clic en 📎 -> abrir diálogo nativo
    onDropFile: () => {},       // (File) archivo soltado sobre la píldora
    isRecording: () => false,
  };
  function configure(callbacks) { cb = { ...cb, ...callbacks }; }

  // ---------------------------------------------------------------------------
  // Ventana: medir alto y pedir a Electron el resize (window.pill.resize).
  // ---------------------------------------------------------------------------
  function syncWindowHeight() {
    const h = Math.ceil(el.pill.getBoundingClientRect().height) + 12; // +12 por margin (6px×2)
    window.pill?.resize(h);
  }
  function refreshLayout() {
    const showCenter = cb.isRecording() || el.status.textContent.trim() !== "";
    el.barCenter.classList.toggle("show", showCenter);
    requestAnimationFrame(syncWindowHeight);
  }

  // ---------------------------------------------------------------------------
  // Estado visible
  // ---------------------------------------------------------------------------
  function fmt(ms) {
    const t = Math.floor(ms / 1000);
    return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  }
  function startTimer() {
    startTime = performance.now();
    el.timer.classList.add("live");
    el.timer.textContent = "00:00";
    timerId = setInterval(() => { el.timer.textContent = fmt(performance.now() - startTime); }, 200);
  }
  function stopTimer() {
    clearInterval(timerId); timerId = null;
    el.timer.classList.remove("live");
  }
  function setStatus(msg) { el.status.textContent = msg || ""; refreshLayout(); }
  function setError(msg) {
    el.err.textContent = msg || "";
    if (msg) el.pill.classList.add("has-result");
    refreshLayout();
  }
  function setResult(text) {
    if (text && text.trim()) {
      el.result.textContent = text.trim();
      el.result.classList.remove("empty");
      el.copyBtn.disabled = false; el.clearBtn.disabled = false;
      el.pill.classList.add("has-result");
    } else {
      el.result.textContent = "El texto transcripto aparecerá acá…";
      el.result.classList.add("empty");
      el.copyBtn.disabled = true; el.clearBtn.disabled = true;
      el.err.textContent = "";
      el.pill.classList.remove("has-result");
    }
    refreshLayout();
  }
  // Reflejar el estado de grabación en el orbe + timer.
  function setRecordingUI(on) {
    el.recBtn.classList.toggle("recording", on);
    if (on) startTimer(); else { stopTimer(); setAudioLevel(0, false); }
  }

  // Medidor de audio en vivo: mientras se graba, el orbe "late" con el volumen y
  // cambia de color según detecte voz (verde) o silencio (rojo). Así el usuario
  // sabe de un vistazo si el micrófono está captando algo. Se llama muchas veces
  // por segundo (rAF), así que solo tocamos estilos baratos (variable CSS + clase).
  function setAudioLevel(level, voice) {
    el.recBtn.style.setProperty("--level", level.toFixed(3));
    el.recBtn.classList.toggle("voice", !!voice);
  }
  function getResultText() { return el.result.textContent; }
  function isConfigOpen() { return configOpen; }

  // ---------------------------------------------------------------------------
  // Config: cargar/guardar, micrófonos, atajos
  // ---------------------------------------------------------------------------
  // Nombres legibles de keycodes uiohook comunes (para el input). Los que no estén
  // se muestran como "Tecla <n>" — igual funcionan (matching por keycode físico).
  const KEYNAMES = {
    1: "Esc", 14: "Backspace", 15: "Tab", 28: "Enter", 57: "Space",
    59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6",
    65: "F7", 66: "F8", 67: "F9", 68: "F10", 87: "F11", 88: "F12",
    53: "/", 51: ",", 52: ".", 39: ";", 40: "'", 12: "-", 13: "=",
    26: "[", 27: "]", 43: "\\",
  };
  function bindLabel(b) {
    if (!b || typeof b.keycode !== "number") return "";
    const mods = [];
    if (b.ctrl) mods.push("Ctrl");
    if (b.shift) mods.push("Shift");
    if (b.alt) mods.push("Alt");
    if (b.meta) mods.push("Win");
    return [...mods, KEYNAMES[b.keycode] || `Tecla ${b.keycode}`].join("+");
  }

  async function loadConfigIntoUI(settings) {
    el.cfgApiKey.value = settings.groqApiKey || "";
    el.cfgLang.value = settings.lang ?? "es";
    el.cfgAction.value = settings.action || "show";
    bindTranscribe = (settings.shortcut && typeof settings.shortcut === "object") ? settings.shortcut : null;
    bindTranslate = (settings.shortcutTranslate && typeof settings.shortcutTranslate === "object") ? settings.shortcutTranslate : null;
    el.cfgShortcut.value = bindLabel(bindTranscribe) || "(sin asignar — hacé clic)";
    el.cfgShortcutTranslate.value = bindLabel(bindTranslate) || "(sin asignar — hacé clic)";
    await populateMics();
    el.cfgMic.value = settings.deviceId || "";
  }

  async function populateMics() {
    try {
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {} // permiso -> labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      el.cfgMic.innerHTML = '<option value="">Por defecto del sistema</option>';
      mics.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Micrófono ${i + 1}`;
        el.cfgMic.appendChild(opt);
      });
    } catch { /* si falla, queda solo "por defecto" */ }
  }

  // Devuelve el objeto de settings que el orquestador debe guardar.
  function readConfigForm() {
    return {
      groqApiKey: el.cfgApiKey.value.trim(),
      lang: el.cfgLang.value,
      deviceId: el.cfgMic.value,
      action: el.cfgAction.value,
      shortcut: bindTranscribe,
      shortcutTranslate: bindTranslate,
    };
  }
  function flashSaved() {
    el.cfgSaved.textContent = "✓ Guardado";
    el.cfgSaved.classList.add("show");
    setTimeout(() => el.cfgSaved.classList.remove("show"), 1600);
  }

  // Captura de atajo vía uiohook (clic en el input -> el main "aprende" la tecla).
  function attachShortcutCapture(input, setBind) {
    input.addEventListener("click", async () => {
      input.value = "Presioná la combinación…";
      const r = await window.pill.captureShortcut();
      if (r && r.ok && r.bind) { setBind(r.bind); input.value = bindLabel(r.bind); }
      else input.value = bindLabel(input === el.cfgShortcut ? bindTranscribe : bindTranslate) || "(sin asignar — hacé clic)";
    });
  }

  // ----- "Dirty": cambios sin guardar en el formulario de config -----
  function markDirty() { dirty = true; }
  function clearDirty() { dirty = false; }
  function isDirty() { return dirty; }

  // Mostrar/ocultar el cuadro "salir sin guardar". Al mostrarlo, la clase .confirming
  // oculta el formulario (campos + Guardar) y deja SOLO la pregunta, para que siempre
  // entre en la ventana (si no, con todos los campos el cuadro queda fuera de pantalla).
  function showConfirm(show) {
    el.cfgConfirm.hidden = !show;
    el.configPanel.classList.toggle("confirming", show);
    refreshLayout();
  }

  // Cerrar la config de verdad (sin preguntar). Resetea estado.
  function closeConfig() {
    configOpen = false;
    dirty = false;
    showConfirm(false);
    el.pill.classList.remove("config-open");
    el.configBtn.classList.remove("active");
    cb.onConfigOpen(false);  // el orquestador: foco + atajos
    refreshLayout();
  }

  function openConfig() {
    configOpen = true;
    dirty = false;
    showConfirm(false);
    el.pill.classList.add("config-open");
    el.configBtn.classList.add("active");
    if (cb.isRecording()) cb.onRecordStop();
    el.pill.classList.remove("has-result");
    setStatus("");
    cb.onConfigOpen(true);  // el orquestador: foco + atajos + cargar config
    refreshLayout();
  }

  // Clic en ⚙: si está abierta, intentar cerrar (con confirmación si hay cambios).
  function toggleConfig() {
    if (configOpen) requestCloseConfig();
    else openConfig();
  }

  // Pedir cierre: si hay cambios sin guardar, pregunta; si no, cierra directo.
  // Devuelve true si cerró, false si quedó esperando confirmación.
  function requestCloseConfig() {
    if (!configOpen) return true;
    if (dirty) { showConfirm(true); return false; }
    closeConfig();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Cableado de eventos del DOM (se llama una vez en init).
  // ---------------------------------------------------------------------------
  function bindEvents() {
    // Orbe: mantener presionado para grabar (modo transcribe por defecto).
    el.recBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); cb.onRecordStart("transcribe"); });
    el.recBtn.addEventListener("pointerup", (e) => { e.preventDefault(); cb.onRecordStop(); });
    el.recBtn.addEventListener("pointerleave", () => { if (cb.isRecording()) cb.onRecordStop(); });
    el.recBtn.addEventListener("contextmenu", (e) => e.preventDefault());

    el.configBtn.addEventListener("click", toggleConfig);
    // ✕: si la config está abierta con cambios, primero pregunta (no cierra la app).
    el.closeBtn.addEventListener("click", () => {
      if (configOpen && dirty) { showConfirm(true); return; }
      window.pill?.close();
    });
    el.cfgSave.addEventListener("click", () => cb.onSaveConfig(readConfigForm()));
    el.cfgTest.addEventListener("click", () => cb.onTest(el.cfgAction.value));

    // Confirmación "salir sin guardar".
    el.cfgConfirmCancel.addEventListener("click", () => showConfirm(false)); // seguir editando
    el.cfgConfirmDiscard.addEventListener("click", () => closeConfig());     // descartar y cerrar

    // Cualquier edición de un campo marca cambios sin guardar.
    [el.cfgApiKey, el.cfgMic, el.cfgLang, el.cfgAction].forEach((node) => {
      node.addEventListener("input", markDirty);
      node.addEventListener("change", markDirty);
    });

    el.copyBtn.addEventListener("click", () => {
      cb.onCopy(el.result.textContent);
      const orig = el.copyBtn.textContent;
      el.copyBtn.textContent = "✅ Copiado";
      setTimeout(() => { el.copyBtn.textContent = orig; }, 1400);
    });
    el.clearBtn.addEventListener("click", () => { setResult(""); setStatus(""); });

    attachShortcutCapture(el.cfgShortcut, (b) => { bindTranscribe = b; markDirty(); });
    attachShortcutCapture(el.cfgShortcutTranslate, (b) => { bindTranslate = b; markDirty(); });

    el.fileBtn.addEventListener("click", () => cb.onPickFile());
    bindDropZone();
  }

  // ---------------------------------------------------------------------------
  // Drag & drop de un audio sobre la píldora
  // ---------------------------------------------------------------------------
  // dragenter/dragleave se disparan también al pasar entre hijos, así que llevamos
  // un contador de "entradas" y solo apagamos el overlay cuando vuelve a 0.
  let dragDepth = 0;
  function setDropping(on) {
    el.pill.classList.toggle("dropping", !!on);
    refreshLayout();
  }

  function bindDropZone() {
    // Sin preventDefault en dragover, Chromium no permite el drop.
    const allow = (e) => { e.preventDefault(); e.stopPropagation(); };

    window.addEventListener("dragenter", (e) => {
      allow(e);
      dragDepth++;
      if (!configOpen) setDropping(true);
    });
    window.addEventListener("dragover", (e) => {
      allow(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      allow(e);
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropping(false);
    });
    window.addEventListener("drop", (e) => {
      allow(e);
      dragDepth = 0;
      setDropping(false);
      if (configOpen) return;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // El preload resuelve la ruta real en disco (el renderer no puede con
      // contextIsolation) y pide al main que lo lea.
      cb.onDropFile(file);
    });
  }

  window.VLUI = {
    configure, bindEvents, refreshLayout,
    setStatus, setError, setResult, setRecordingUI, setAudioLevel,
    getResultText, isConfigOpen, toggleConfig,
    closeConfig, requestCloseConfig, isDirty, clearDirty,
    loadConfigIntoUI, readConfigForm, flashSaved,
    // helper para el test "solo mostrar"
    cfgActionValue: () => el.cfgAction.value,
    setTestBusy: (busy) => { el.cfgTest.disabled = busy; },
    // 📎 deshabilitado mientras se sube/transcribe un archivo (evita dobles envíos).
    setFileBusy: (busy) => { el.fileBtn.disabled = busy; el.fileBtn.classList.toggle("busy", !!busy); },
  };
})();
