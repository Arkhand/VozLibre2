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
    fileBtn: $("fileBtn"), historyBtn: $("historyBtn"), meetBtn: $("meetBtn"),
    // Reunión en curso
    meetPanel: $("meetPanel"), meetDot: $("meetDot"), meetState: $("meetState"),
    meetTimer: $("meetTimer"), meetLvlSys: $("meetLvlSys"), meetLvlMic: $("meetLvlMic"),
    meetNote: $("meetNote"), meetStop: $("meetStop"),
    // Historial
    historyPanel: $("historyPanel"), histList: $("histList"), histClose: $("histClose"),
    histClear: $("histClear"), histFolderBtn: $("histFolderBtn"), savedPath: $("savedPath"),
    // Confirmacion de archivo largo + progreso de conversion
    fileConfirm: $("fileConfirm"), fcTitle: $("fcTitle"), fcDetail: $("fcDetail"),
    fcCancel: $("fcCancel"), fcOk: $("fcOk"),
    progress: $("progress"), progressBar: $("progressBar"),
    barCenter: $("barCenter"), status: $("status"), timer: $("timer"),
    result: $("result"), copyBtn: $("copyBtn"), clearBtn: $("clearBtn"), err: $("err"),
    // Config
    cfgApiKey: $("cfgApiKey"), cfgMic: $("cfgMic"), cfgLang: $("cfgLang"), cfgAction: $("cfgAction"),
    cfgChunk: $("cfgChunk"),
    cfgFormat: $("cfgFormat"), cfgFormatHint: $("cfgFormatHint"), cfgTimestamps: $("cfgTimestamps"),
    cfgSaveHistory: $("cfgSaveHistory"), cfgFolder: $("cfgFolder"), cfgFolderBtn: $("cfgFolderBtn"),
    cfgShortcut: $("cfgShortcut"), cfgShortcutTranslate: $("cfgShortcutTranslate"),
    cfgSave: $("cfgSave"), cfgSaved: $("cfgSaved"), cfgTest: $("cfgTest"),
    configPanel: $("configPanel"),
    // Confirmación "salir sin guardar"
    cfgConfirm: $("cfgConfirm"), cfgConfirmCancel: $("cfgConfirmCancel"),
    cfgConfirmDiscard: $("cfgConfirmDiscard"),
  };

  let configOpen = false;
  let historyOpen = false;
  // Carpeta elegida en el formulario de config (vacía = la por defecto).
  let historyFolder = "";
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
    // Historial
    onHistoryList: async () => ({ ok: true, entries: [] }),
    onHistoryOpenEntry: () => {},   // (id) cargar el texto en el panel de resultado
    onHistoryOpenFile: () => {},    // (id) abrir el .md con la app del sistema
    onHistoryReveal: () => {},      // (id) mostrar en el explorador
    onHistoryRemove: () => {},      // (id) sacar del índice (no borra el .md)
    onHistoryClear: () => {},
    // Config: carpeta y estado del CLI
    onPickHistoryFolder: async () => null,
    onOpenHistoryFolder: () => {},  // abrir la carpeta en el explorador
    onGetHistoryFolder: async () => ({ folder: "", isDefault: true }),
    onGetFormatStatus: async () => ({ available: false, hint: "" }),
    onRecheckFormat: async () => ({ available: false, hint: "" }),
    // Reuniones
    onMeetStart: () => {},
    onMeetStop: () => {},
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
      setSavedPath("");
      el.pill.classList.remove("has-result");
    }
    refreshLayout();
  }

  // Ruta donde quedó el .md guardado. Se muestra bajo el resultado para que sepas
  // dónde buscarlo sin abrir el historial.
  function setSavedPath(p) {
    if (!p) {
      el.savedPath.hidden = true;
      el.savedPath.textContent = "";
    } else {
      el.savedPath.hidden = false;
      el.savedPath.textContent = "💾 " + p;
      el.savedPath.title = p;
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
  // Archivos largos: confirmación previa y progreso de conversión
  // ---------------------------------------------------------------------------
  // Un mp4 de 1 h tarda en convertirse y gasta varias llamadas a la API, así que
  // antes de arrancar se muestra qué se va a hacer y se espera el OK.
  let confirmResolve = null;

  function fmtDuration(seconds) {
    const s = Math.round(seconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
    if (m > 0) return `${m} min ${String(sec).padStart(2, "0")} s`;
    return `${sec} s`;
  }

  // Muestra el cuadro y resuelve true/false según lo que elija el usuario.
  function askFileConfirm(plan) {
    el.fcTitle.textContent = plan.isVideo ? "🎬 Video largo" : "🎧 Audio largo";
    const partes = plan.parts > 1
      ? ` Se va a cortar en ${plan.parts} partes (en silencios) y se transcribe cada una.`
      : "";
    const extrae = plan.isVideo ? " Se le extrae el audio y se comprime." : " Se comprime a Opus.";
    el.fcDetail.textContent =
      `${plan.name} — ${fmtDuration(plan.duration)}, ${plan.sizeMB.toFixed(1)} MB.` +
      extrae + partes + " Esto consume API.";

    el.fileConfirm.hidden = false;
    el.pill.classList.add("file-confirming");
    refreshLayout();

    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  function closeFileConfirm(answer) {
    el.fileConfirm.hidden = true;
    el.pill.classList.remove("file-confirming");
    refreshLayout();
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(answer);
  }

  // Barra de progreso de ffmpeg (0..1). Con null se oculta.
  function setProgress(value) {
    if (value === null || value === undefined) {
      el.progress.classList.remove("show");
      el.progressBar.style.width = "0%";
    } else {
      el.progress.classList.add("show");
      el.progressBar.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
    }
    refreshLayout();
  }

  // ---------------------------------------------------------------------------
  // Reunión en curso: indicador, cronómetro y medidores
  // ---------------------------------------------------------------------------
  let meetingOn = false;

  function setMeetingUI(on, info = {}) {
    meetingOn = !!on;
    el.pill.classList.toggle("meeting-on", meetingOn);
    el.meetBtn.classList.toggle("recording", meetingOn);
    el.meetBtn.title = meetingOn ? "Grabando… clic para detener" : "Grabar una reunión (Teams, Zoom, Meet…)";
    if (meetingOn) {
      el.meetTimer.textContent = "00:00";
      setMeetingLevels(0, 0);
      // Sin micrófono se graba igual, pero conviene decirlo: si no, el usuario cree
      // que se está grabando su voz y descubre que no al leer el transcript.
      el.meetNote.textContent = info.hasMic === false
        ? "⚠️ Sin micrófono: se graba solo el audio de la reunión, no tu voz."
        : "Se transcribe por partes mientras grabás.";
      el.meetState.textContent = "Grabando reunión";
    }
    refreshLayout();
  }

  function setMeetingTime(seconds) {
    const t = Math.floor(seconds || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = (n) => String(n).padStart(2, "0");
    el.meetTimer.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Se llama varias veces por segundo: solo tocamos el ancho (barato).
  function setMeetingLevels(mic, sistema) {
    el.meetLvlMic.style.width = Math.round(Math.max(0, Math.min(1, mic)) * 100) + "%";
    el.meetLvlSys.style.width = Math.round(Math.max(0, Math.min(1, sistema)) * 100) + "%";
  }

  // Mientras se transcribe al final, el panel sigue visible pero ya no "grabando".
  function setMeetingState(msg) {
    el.meetState.textContent = msg;
    el.meetDot.style.animation = "none";
    refreshLayout();
  }

  function isMeetingOn() { return meetingOn; }

  // ---------------------------------------------------------------------------
  // Historial de transcripciones
  // ---------------------------------------------------------------------------
  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      const hoy = new Date();
      const mismaFecha = d.toDateString() === hoy.toDateString();
      const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      if (mismaFecha) return `hoy ${hora}`;
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hora}`;
    } catch { return ""; }
  }

  // Construye la lista con DOM (no innerHTML): los títulos salen del nombre de
  // archivo del usuario y concatenarlos como HTML sería una inyección.
  function renderHistory(entries) {
    el.histList.textContent = "";
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "hist-empty";
      empty.textContent = "Todavía no transcribiste ningún archivo.";
      el.histList.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "hist-item" + (e.missing ? " missing" : "");

      const main = document.createElement("button");
      main.className = "hist-main";
      main.title = e.missing ? `Falta el archivo: ${e.path}` : "Ver el texto acá";
      main.disabled = !!e.missing;

      const title = document.createElement("span");
      title.className = "hist-name";
      title.textContent = (e.missing ? "⚠️ " : "") + (e.title || "(sin título)");

      const meta = document.createElement("span");
      meta.className = "hist-meta";
      const bits = [fmtDate(e.savedAt)];
      if (e.duration) bits.push(fmtDuration(e.duration));
      if (e.language) bits.push(e.language.toUpperCase());
      if (!e.formatted) bits.push("sin formato");
      meta.textContent = bits.filter(Boolean).join(" · ");

      main.append(title, meta);
      main.addEventListener("click", () => cb.onHistoryOpenEntry(e.id));

      const openBtn = document.createElement("button");
      openBtn.className = "hist-act";
      openBtn.textContent = "📄";
      openBtn.title = "Abrir el .md";
      openBtn.disabled = !!e.missing;
      openBtn.addEventListener("click", () => cb.onHistoryOpenFile(e.id));

      const revealBtn = document.createElement("button");
      revealBtn.className = "hist-act";
      revealBtn.textContent = "📂";
      revealBtn.title = "Mostrar en la carpeta";
      revealBtn.disabled = !!e.missing;
      revealBtn.addEventListener("click", () => cb.onHistoryReveal(e.id));

      const delBtn = document.createElement("button");
      delBtn.className = "hist-act";
      delBtn.textContent = "✕";
      delBtn.title = "Sacar de la lista (no borra el archivo)";
      delBtn.addEventListener("click", async () => {
        await cb.onHistoryRemove(e.id);
        await openHistory(true); // refrescar
      });

      row.append(main, openBtn, revealBtn, delBtn);
      el.histList.appendChild(row);
    }
  }

  // refreshOnly: recargar la lista sin togglear el panel (tras borrar una entrada).
  async function openHistory(refreshOnly = false) {
    if (!refreshOnly) {
      if (configOpen && !requestCloseConfig()) return; // config sucia: primero decidir
      historyOpen = true;
      el.pill.classList.add("history-open");
      el.historyBtn.classList.add("active");
    }
    const r = await cb.onHistoryList();
    renderHistory(r?.entries || []);
    refreshLayout();
  }

  function closeHistory() {
    historyOpen = false;
    el.pill.classList.remove("history-open");
    el.historyBtn.classList.remove("active");
    refreshLayout();
  }

  function toggleHistory() {
    if (historyOpen) closeHistory();
    else openHistory();
  }
  function isHistoryOpen() { return historyOpen; }

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
    el.cfgChunk.value = String(settings.chunkMinutes ?? 10);
    bindTranscribe = (settings.shortcut && typeof settings.shortcut === "object") ? settings.shortcut : null;
    bindTranslate = (settings.shortcutTranslate && typeof settings.shortcutTranslate === "object") ? settings.shortcutTranslate : null;
    el.cfgShortcut.value = bindLabel(bindTranscribe) || "(sin asignar — hacé clic)";
    el.cfgShortcutTranslate.value = bindLabel(bindTranslate) || "(sin asignar — hacé clic)";

    // Formateo: el check se deshabilita si no hay CLI, y el hint explica por qué
    // (si no, queda un check muerto sin explicación).
    //
    // null = el main todavía no resolvió el default (settings.json viejo, o la
    // config se abrió antes de que corriera resolveFormatDefault). Se cae al mismo
    // criterio: prendido si el CLI está. Sin esto el check se vería apagado y al
    // guardar quedaría apagado de verdad, sin que el usuario lo haya elegido.
    const st = await cb.onGetFormatStatus();
    el.cfgFormat.checked = settings.formatMarkdown === null || settings.formatMarkdown === undefined
      ? !!st?.available
      : !!settings.formatMarkdown;
    el.cfgTimestamps.checked = settings.formatTimestamps !== false;
    applyFormatAvailability(st);

    // Historial
    el.cfgSaveHistory.checked = settings.saveHistory !== false;
    historyFolder = settings.historyFolder || "";
    const f = await cb.onGetHistoryFolder();
    el.cfgFolder.value = historyFolder || f?.folder || "";
    el.cfgFolder.placeholder = f?.folder || "Documentos\\VozLibre";
    syncHistoryEnabled();

    await populateMics();
    el.cfgMic.value = settings.deviceId || "";
  }

  // Consulta el estado del CLI y ajusta el check (para el botón de re-chequear).
  async function refreshFormatAvailability() {
    applyFormatAvailability(await cb.onGetFormatStatus());
  }

  // Ajusta el check de formateo según haya CLI o no. Recibe el estado ya
  // consultado para no pedirlo dos veces al abrir la config.
  function applyFormatAvailability(st) {
    const ok = !!st?.available;
    el.cfgFormat.disabled = !ok;
    el.cfgTimestamps.disabled = !ok || !el.cfgFormat.checked;
    if (!ok) {
      el.cfgFormat.checked = false;
      el.cfgFormatHint.textContent =
        (st?.hint || "Claude Code no está instalado.") +
        " Sin esto la transcripción se guarda sin formato.";
      el.cfgFormatHint.classList.add("warn");
    } else {
      el.cfgFormatHint.textContent =
        "Convierte el texto corrido en párrafos con puntuación, cortando donde hubo pausas reales en el audio. No inventa hablantes ni cambia las palabras.";
      el.cfgFormatHint.classList.remove("warn");
    }
  }

  // Los sub-controles del historial no tienen sentido con el guardado apagado.
  function syncHistoryEnabled() {
    const on = el.cfgSaveHistory.checked;
    el.cfgFolder.disabled = !on;
    el.cfgFolderBtn.disabled = !on;
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
      chunkMinutes: Number(el.cfgChunk.value) || 10,
      shortcut: bindTranscribe,
      shortcutTranslate: bindTranslate,
      formatMarkdown: el.cfgFormat.checked,
      formatTimestamps: el.cfgTimestamps.checked,
      saveHistory: el.cfgSaveHistory.checked,
      historyFolder,
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
    if (historyOpen) closeHistory(); // los dos paneles no conviven
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
    [el.cfgApiKey, el.cfgMic, el.cfgLang, el.cfgAction, el.cfgChunk,
     el.cfgFormat, el.cfgTimestamps, el.cfgSaveHistory].forEach((node) => {
      node.addEventListener("input", markDirty);
      node.addEventListener("change", markDirty);
    });

    // Los timestamps dependen del formateo: sin formateo no hay dónde ponerlos.
    el.cfgFormat.addEventListener("change", () => {
      el.cfgTimestamps.disabled = !el.cfgFormat.checked;
    });
    el.cfgSaveHistory.addEventListener("change", syncHistoryEnabled);

    // Elegir carpeta de guardado (diálogo nativo en el main).
    el.cfgFolderBtn.addEventListener("click", async () => {
      const folder = await cb.onPickHistoryFolder();
      if (!folder) return;
      historyFolder = folder;
      el.cfgFolder.value = folder;
      markDirty();
    });

    // Reunión: el mismo botón arranca y detiene.
    el.meetBtn.addEventListener("click", () => {
      if (meetingOn) cb.onMeetStop();
      else cb.onMeetStart();
    });
    el.meetStop.addEventListener("click", () => cb.onMeetStop());

    // Historial
    el.historyBtn.addEventListener("click", toggleHistory);
    el.histClose.addEventListener("click", closeHistory);
    el.histFolderBtn.addEventListener("click", () => cb.onOpenHistoryFolder());
    el.histClear.addEventListener("click", async () => {
      await cb.onHistoryClear();
      await openHistory(true);
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
    el.fcOk.addEventListener("click", () => closeFileConfirm(true));
    el.fcCancel.addEventListener("click", () => closeFileConfirm(false));
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
    setStatus, setError, setResult, setRecordingUI, setAudioLevel, setSavedPath,
    getResultText, isConfigOpen, toggleConfig,
    // Historial
    toggleHistory, openHistory, closeHistory, isHistoryOpen,
    // Reunión
    setMeetingUI, setMeetingTime, setMeetingLevels, setMeetingState, isMeetingOn,
    closeConfig, requestCloseConfig, isDirty, clearDirty,
    loadConfigIntoUI, readConfigForm, flashSaved,
    // helper para el test "solo mostrar"
    cfgActionValue: () => el.cfgAction.value,
    setTestBusy: (busy) => { el.cfgTest.disabled = busy; },
    // 📎 deshabilitado mientras se sube/transcribe un archivo (evita dobles envíos).
    setFileBusy: (busy) => { el.fileBtn.disabled = busy; el.fileBtn.classList.toggle("busy", !!busy); },
    // Archivos largos: confirmación previa + progreso de la conversión.
    askFileConfirm, closeFileConfirm, setProgress, fmtDuration,
  };
})();
