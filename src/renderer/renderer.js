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
  async function applyAction(text) {
    if (!text) { UI.setStatus(""); UI.setError("No se reconoció texto."); return; }
    const action = settings.action || "show";
    UI.setResult(text); // siempre mostramos el texto como referencia

    if (action === "show") { UI.setStatus("Listo."); return; }
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

  // ---- Conectar Transcription con la UI ----
  TR.configure({
    getSettings: () => settings,
    onStatus: (m) => UI.setStatus(m),
    onError: (m) => UI.setError(m),
    onText: (text) => applyAction(text),
    onRecordingChange: (on) => UI.setRecordingUI(on),
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
