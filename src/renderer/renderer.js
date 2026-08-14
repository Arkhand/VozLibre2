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
  // Recibe lo que devuelve el main ({ok, name, ext, bytes} | {ok:false, ...}) y lo
  // manda a transcribir. transcribeFile marca el origen, así que el resultado se
  // muestra sin aplicar pegar/teclear (ver applyAction).
  async function transcribeFromFileResult(r) {
    if (!r || r.canceled) return;
    if (!r.ok) { UI.setError(r.error || "No se pudo abrir el archivo."); UI.setStatus(""); return; }
    UI.setFileBusy(true);
    UI.setError("");
    UI.setStatus(`Leyendo ${r.name}…`);
    try {
      await TR.transcribeFile(r.bytes, r.ext, "transcribe");
    } finally {
      UI.setFileBusy(false);
    }
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
      const r = await window.pill.pickAudio();
      await transcribeFromFileResult(r);
    },
    onDropFile: async (file) => {
      const r = await window.pill.readDroppedAudio(file);
      await transcribeFromFileResult(r);
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

  // ---- Init ----
  window.addEventListener("DOMContentLoaded", async () => {
    UI.bindEvents();
    settings = await window.pill.loadSettings();
    UI.refreshLayout();
  });
})();
