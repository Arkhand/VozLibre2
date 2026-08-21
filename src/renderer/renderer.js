/* VozLibre2 — Orquestador del renderer
 * =====================================
 * Pega los módulos del renderer entre sí y con el proceso main (window.pill):
 *   - VLUI            → UI/DOM (estados, layout, panel de config).
 *   - VLTranscription → grabación + llamada a Groq.
 *   - window.pill     → puente IPC (settings, paste/type, atajos, push-to-talk).
 * Acá viven: el flujo de grabar→reconocer→aplicar acción, el push-to-talk global y
 * la carga/guardado de config. La lógica concreta está en cada módulo.
 */
(function () {
  const UI = window.VLUI;
  const TR = window.VLTranscription;

  let settings = {};

  // ---- Aplicar la acción configurada al texto reconocido ----
  // fromFile: el audio venía de un archivo (📎 o drag & drop). En ese caso NUNCA
  // se aplica pegar/teclear: estás mirando la píldora, no la app de atrás, así que
  // escribirle a esa ventana sería una sorpresa fea. El texto queda a un clic de 📋.
  async function applyAction(text, fromFile = false) {
    if (!text) { UI.setStatus(""); UI.setError("No se reconoció texto."); return; }
    const action = fromFile ? "show" : (settings.action || "show");
    UI.setResult(text); // siempre mostramos el texto como referencia

    if (action === "show") { UI.setStatus(fromFile ? "Listo — copiá el texto con 📋" : "Listo."); return; }
    if (action === "paste") {
      const r = await window.pill.paste(text);
      UI.setStatus(r?.ok ? "Pegado (Ctrl+V) ✓" : "No se pudo pegar");
      if (!r?.ok) UI.setError(r?.error || "Error al pegar");
      return;
    }
    if (action === "type") {
      UI.setStatus("Tecleando…");
      const r = await window.pill.type(text);
      UI.setStatus(r?.ok ? "Tecleado ✓" : "No se pudo teclear");
      if (!r?.ok) UI.setError(r?.error || "Error al teclear");
    }
  }

  // ---- Audio desde archivo (📎 o drag & drop) ----
  // El main manda un PLAN (duración, si es video, en cuántas partes saldría) sin
  // haber convertido nada. Con eso decidimos el camino:
  //   - direct: audio chico y compatible -> se sube tal cual (no necesita ffmpeg).
  //   - largo/video -> se confirma con el usuario, ffmpeg extrae+comprime+parte,
  //     y se transcribe parte por parte concatenando el texto.
  // El resultado nunca dispara pegar/teclear (ver applyAction).
  async function transcribeFromPlan(plan) {
    if (!plan || plan.canceled) return;
    if (!plan.ok) {
      UI.setStatus("");
      UI.setError(plan.error || "No se pudo abrir el archivo.");
      return;
    }

    UI.setFileBusy(true);
    UI.setError("");
    try {
      // --- Camino directo: nota de voz normal, sin ffmpeg de por medio ---
      if (plan.direct) {
        UI.setStatus(`Leyendo ${plan.name}…`);
        const r = await window.pill.readAudio(plan.path);
        if (!r.ok) { UI.setStatus(""); UI.setError(r.error); return; }
        await TR.transcribeFile(r.bytes, r.ext, "transcribe");
        return;
      }

      // --- Camino largo: confirmar antes de gastar tiempo y API ---
      const ok = await UI.askFileConfirm(plan);
      if (!ok) { UI.setStatus(""); return; }

      UI.setStatus(plan.isVideo ? "Extrayendo el audio…" : "Comprimiendo el audio…");
      UI.setProgress(0);
      const prep = await window.pill.prepareAudio(plan.path);
      UI.setProgress(null);
      if (!prep.ok) { UI.setStatus(""); UI.setError(prep.error); return; }

      try {
        await transcribeParts(prep.parts);
      } finally {
        // Los trozos temporales se borran siempre, aunque falle a mitad.
        await window.pill.cleanupAudio(prep.tmpDir);
      }
    } finally {
      UI.setFileBusy(false);
      UI.setProgress(null);
    }
  }

  // Transcribe las partes EN SERIE (no en paralelo: Groq tiene rate limits y así
  // el texto sale en orden) y va mostrando lo que lleva acumulado, para que en un
  // archivo largo veas avanzar el resultado en vez de esperar a ciegas.
  async function transcribeParts(parts) {
    const trozos = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      UI.setStatus(`Transcribiendo parte ${i + 1} de ${parts.length}…`);
      UI.setProgress(i / parts.length);

      const text = await TR.transcribeToText(p.bytes, p.ext, "transcribe");
      if (text === null) {
        // Falló una parte: conservamos lo transcripto hasta acá en vez de perder todo.
        if (trozos.length) {
          UI.setResult(trozos.join(" "));
          UI.setError(`Falló la parte ${i + 1} de ${parts.length}. Arriba está lo que sí se transcribió.`);
        }
        UI.setStatus("");
        UI.setProgress(null);
        return;
      }
      if (text) trozos.push(text);
      UI.setResult(trozos.join(" ")); // avance visible parte a parte
    }

    UI.setProgress(null);
    await applyAction(trozos.join(" "), true);
  }

  // ---- Conectar Transcription con la UI ----
  TR.configure({
    getSettings: () => settings,
    onStatus: (m) => UI.setStatus(m),
    onError: (m) => UI.setError(m),
    onText: (text, _mode, opts) => applyAction(text, !!opts?.fromFile),
    onRecordingChange: (on) => UI.setRecordingUI(on),
    onLevel: (level, voice) => UI.setAudioLevel(level, voice),
  });

  // ---- Conectar la UI con el resto ----
  UI.configure({
    isRecording: () => TR.isRecording(),
    onRecordStart: (mode) => TR.start(mode),
    onRecordStop: () => TR.stop(),
    onConfigOpen: async (open) => {
      // La píldora toma foco solo con la config abierta (para escribir); el main
      // desactiva/reactiva los atajos globales en consecuencia.
      window.pill.setFocusable(open);
      if (open) { settings = await window.pill.loadSettings(); await UI.loadConfigIntoUI(settings); }
    },
    onSaveConfig: async (formValues) => {
      settings = await window.pill.saveSettings(formValues);
      TR.releaseStream(); // el próximo getStream usará el micrófono nuevo
      UI.flashSaved();
      UI.clearDirty();    // cambios ya persistidos: no preguntar al cerrar
      UI.closeConfig();   // guardar cierra el panel de config
    },
    onPickFile: async () => {
      const plan = await window.pill.pickAudio();
      await transcribeFromPlan(plan);
    },
    onDropFile: async (file) => {
      const plan = await window.pill.planDroppedAudio(file);
      await transcribeFromPlan(plan);
    },
    onCopy: async (text) => {
      await window.pill.copyToClipboard(text);
      // feedback breve en el botón lo maneja la UI vía clase; acá basta el copiado
    },
    onTest: async (action) => {
      if (action === "show") {
        UI.setResult("Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123");
        UI.setStatus('Acción "Solo mostrar": el texto aparece acá ✓');
        return;
      }
      if (UI.isConfigOpen()) UI.toggleConfig(); // cerrar para soltar el foco
      UI.setTestBusy(true);
      UI.setStatus("Enfocá tu app… (1,5 s)");
      const r = await window.pill.testAction(action);
      UI.setTestBusy(false);
      if (r?.ok) UI.setStatus(action === "paste" ? "Pegado (Ctrl+V) ✓" : "Tecleado ✓");
      else UI.setError("Falló: " + (r?.error || "desconocido"));
    },
  });

  // ---- Push-to-talk global (desde el main vía uiohook) ----
  // mantener = grabar, soltar = transcribir/traducir. A prueba de cruces: si ya hay
  // grabación, se ignora otro DOWN; y solo corta el UP cuyo modo coincide con el que
  // inició la grabación (no se mezcla español con inglés).
  let activeMode = null;
  window.pill.onPttDown((mode) => {
    if (UI.isConfigOpen() || TR.isRecording()) return;
    activeMode = mode;
    TR.start(mode);
  });
  window.pill.onPttUp((mode) => {
    if (UI.isConfigOpen() || !TR.isRecording()) return;
    if (mode && mode !== activeMode) return;
    TR.stop();
  });

  // ---- Avance de ffmpeg (archivos largos) ----
  // El main avisa en qué etapa va: convertir (con % real), detectar silencios y
  // cortar. Sin esto la píldora se queda muda varios minutos con un mp4 de 1 h.
  window.pill.onAudioProgress((p) => {
    if (!p) return;
    if (p.stage === "convert") {
      if (typeof p.progress === "number") UI.setProgress(p.progress);
      return;
    }
    if (p.stage === "silence") { UI.setStatus("Buscando los silencios para cortar…"); UI.setProgress(null); return; }
    if (p.stage === "split") { UI.setStatus(`Cortando en ${p.total} partes…`); return; }
  });

  // ---- Init ----
  window.addEventListener("DOMContentLoaded", async () => {
    UI.bindEvents();
    settings = await window.pill.loadSettings();
    UI.refreshLayout();
  });
})();
