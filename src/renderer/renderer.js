/* VozLibre2 — Orquestador del renderer
 * =====================================
 * Pega los módulos del renderer entre sí y con el proceso main (window.pill):
 *   - VLUI            → UI/DOM (estados, layout, panel de config).
 *   - VLProgress      → estado de avance de los trabajos largos (etapa, %, tiempos).
 *   - VLTranscription → grabación + llamada a Groq.
 *   - window.pill     → puente IPC (settings, paste/type, atajos, push-to-talk).
 * Acá viven: el flujo de grabar→reconocer→aplicar acción, el push-to-talk global y
 * la carga/guardado de config. La lógica concreta está en cada módulo.
 */
(function () {
  const t = window.VLI18n.t;
  const UI = window.VLUI;
  const TR = window.VLTranscription;
  const MT = window.VLMeeting;
  const JOB = window.VLProgress;

  let settings = {};
  // Errores del renderer al log del main (en el .exe no hay consola).
  const log = (level, msg) => window.pill?.log(level, msg);
  window.addEventListener("error", (e) => log("error", `window.error: ${e.message} @${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => log("error", `unhandledrejection: ${e.reason?.stack || e.reason}`));

  // ---- Aplicar la acción configurada al texto reconocido ----
  // fromFile: el audio venía de un archivo (📎 o drag & drop). En ese caso NUNCA
  // se aplica pegar/teclear: estás mirando la píldora, no la app de atrás, así que
  // escribirle a esa ventana sería una sorpresa fea. El texto queda a un clic de 📋.
  async function applyAction(text, fromFile = false) {
    if (!text) { UI.setStatus(""); UI.setError(t("No se reconoció texto.")); return; }
    const action = fromFile ? "show" : (settings.action || "show");
    UI.setResult(text); // siempre mostramos el texto como referencia

    if (action === "show") { UI.setStatus(fromFile ? t("Listo — copiá el texto con 📋") : t("Listo.")); return; }
    if (action === "paste") {
      const r = await window.pill.paste(text);
      UI.setStatus(r?.ok ? t("Pegado (Ctrl+V) ✓") : t("No se pudo pegar"));
      if (!r?.ok) UI.setError(r?.error || t("Error al pegar"));
      return;
    }
    if (action === "type") {
      UI.setStatus(t("Tecleando…"));
      const r = await window.pill.type(text);
      UI.setStatus(r?.ok ? t("Tecleado ✓") : t("No se pudo teclear"));
      if (!r?.ok) UI.setError(r?.error || t("Error al teclear"));
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
      // El preload no tiene diccionario: devuelve un código y acá se traduce.
      const msg = plan.code === "no-path" ? t("Arrastrá el archivo desde una carpeta del disco.") : plan.error;
      UI.setError(msg || t("No se pudo abrir el archivo."));
      return;
    }

    UI.setFileBusy(true);
    UI.setError("");
    try {
      // --- Camino directo: nota de voz normal, sin ffmpeg de por medio ---
      // Va por transcribeParts igual que el camino largo (con una sola "parte"),
      // para que un .ogg de WhatsApp también salga formateado y quede en el
      // historial. Sin silencios: no pasó por ffmpeg, así que el formateador arma
      // los párrafos solo con la puntuación.
      if (plan.direct) {
        JOB.start({ kind: "file", title: plan.name });
        JOB.phase(t("Leyendo {name}…", { name: plan.name }));
        const r = await window.pill.readAudio(plan.path);
        if (!r.ok) { UI.setStatus(""); UI.setError(r.error); return; }
        const dur = plan.duration || 0;
        await transcribeParts(
          [{ bytes: r.bytes, ext: r.ext, start: 0, end: dur }],
          { sourceName: plan.name, duration: dur, silences: [] }
        );
        return;
      }

      // --- Camino largo: confirmar antes de gastar tiempo y API ---
      const ok = await UI.askFileConfirm(plan);
      if (!ok) { UI.setStatus(""); return; }

      // Desde acá hay trabajo largo de verdad: el panel de avance queda a la
      // vista hasta el final, pase por los paneles que pase el usuario.
      JOB.start({ kind: "file", title: `${plan.name} · ${UI.fmtDuration(plan.duration)}` });
      JOB.phase(plan.isVideo ? t("Extrayendo el audio del video…") : t("Comprimiendo el audio…"), { fraction: 0 });
      const prep = await window.pill.prepareAudio(plan.path);
      if (!prep.ok) { UI.setStatus(""); UI.setError(prep.error); return; }

      try {
        await transcribeParts(prep.parts, {
          sourceName: plan.name,
          duration: prep.duration,
          silences: prep.silences || [],
        });
      } finally {
        // Los trozos temporales se borran siempre, aunque falle a mitad.
        await window.pill.cleanupAudio(prep.tmpDir);
      }
    } finally {
      UI.setFileBusy(false);
      JOB.finish();
    }
  }

  // Transcribe las partes EN SERIE (no en paralelo: Groq tiene rate limits y así
  // el texto sale en orden) y va mostrando lo que lleva acumulado, para que en un
  // archivo largo veas avanzar el resultado en vez de esperar a ciegas.
  async function transcribeParts(parts, meta = {}) {
    // Cada trozo guarda su texto y su ubicación en el audio: el formateador los usa
    // para poner los encabezados con marca de tiempo en el lugar correcto.
    const trozos = [];
    let language = "";

    const unaSola = parts.length === 1;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // done = partes YA terminadas: con eso el panel estima cuánto falta a
      // partir de lo que tardaron las anteriores (nada de promedios inventados).
      // Con una sola parte no hay nada que contar ni con qué estimar: barra
      // indeterminada (se mueve) en vez de un 0 % que no avanza nunca.
      JOB.phase(
        unaSola ? t("Transcribiendo con Groq…") : t("Transcribiendo parte {i} de {n}…", { i: i + 1, n: parts.length }),
        unaSola ? { steps: 0 } : { steps: parts.length, done: i }
      );

      const r = await TR.transcribeToText(p.bytes, p.ext, "transcribe", p.mapping);
      if (r === null) {
        // Falló una parte: conservamos lo transcripto hasta acá en vez de perder todo.
        if (trozos.length) {
          UI.setResult(joinRaw(trozos));
          UI.setError(t("Falló la parte {i} de {n}. Arriba está lo que sí se transcribió.", { i: i + 1, n: parts.length }));
        }
        UI.setStatus("");
        return;
      }
      // El idioma del primer trozo con texto manda: es el mismo audio de punta a
      // punta, y Whisper puede dudar en un trozo de puro silencio o música.
      if (!language && r.language) language = r.language;
      if (r.text) trozos.push({ text: r.text, start: p.start ?? 0, end: p.end ?? 0 });
      UI.setResult(joinRaw(trozos)); // avance visible parte a parte
    }
    JOB.phase(t("Transcripción completa"), { steps: parts.length, done: parts.length });

    if (!trozos.length) { UI.setStatus(""); UI.setError(t("No se reconoció texto en el audio.")); return; }

    // Avisar si el audio no era el idioma configurado: es la causa más común de
    // "pedí inglés y me salió español" (Whisper TRADUCE cuando se le fija idioma).
    warnLanguageMismatch(language);

    const finished = await finishTranscript(trozos, { ...meta, language, kind: "file" });
    JOB.finish();
    await applyAction(finished, true);
  }

  // Texto crudo mientras avanza (sin formatear): un espacio entre trozos.
  function joinRaw(trozos) { return trozos.map((t) => t.text).join(" "); }

  // Si el usuario fijó un idioma y Whisper detectó otro, el texto viene traducido,
  // no transcripto. Es un aviso, no un error: el texto igual sirve.
  function warnLanguageMismatch(detected) {
    const chosen = settings.lang || "";
    if (!chosen || !detected || detected === chosen) return;
    UI.setError(t(
      "⚠️ El audio parece estar en {detected} pero tenés fijado {chosen}, así que Whisper lo TRADUJO en vez de transcribirlo. Poné \"Detectar automáticamente\" en ⚙ para el texto literal.",
      { detected: langName(detected), chosen: langName(chosen) }
    ));
  }

  const LANG_NAMES = {
    es: "español", en: "inglés", pt: "portugués", fr: "francés", it: "italiano",
    de: "alemán", ca: "catalán", gl: "gallego", eu: "euskera", nl: "neerlandés",
    ja: "japonés", zh: "chino", ru: "ruso", ar: "árabe",
  };
  function langName(code) { return LANG_NAMES[code] ? t(LANG_NAMES[code]) : code; }

  // Formatea a Markdown (si está prendido y hay CLI) y guarda el .md en el
  // historial. Devuelve el texto final para mostrar. Ni el formateo ni el guardado
  // pueden hacer perder la transcripción: si fallan, se sigue con el crudo.
  //
  // meta.kind: "meeting" manda el .md a la subcarpeta Reuniones/.
  // meta.noTimestamps: el texto ya trae sus marcas (reuniones) y el formateador no
  // debe agregar otra capa de encabezados encima.
  async function finishTranscript(trozos, meta) {
    const raw = joinRaw(trozos);
    let text = raw;
    let formatted = false, partial = false, failedCount = 0, formatError = "";

    if (settings.formatMarkdown) {
      JOB.phase(t("Dando formato al texto…"), { fraction: 0 });
      const r = await window.pill.formatTranscript({
        parts: trozos,
        language: meta.language || "",
        // Encabezados con marca de tiempo solo si el audio se partió: en un audio
        // de una sola parte no hay tramos que separar.
        showTimestamps: !meta.noTimestamps && !!settings.formatTimestamps && trozos.length > 1,
        silences: meta.silences || [],
      });

      if (r?.ok && r.text) {
        text = r.text;
        formatted = true;
        partial = !!r.partial;
        failedCount = r.failedCount || 0;
        if (partial) UI.setError(t("⚠️ {n} parte(s) quedaron sin formatear: {error}", { n: failedCount, error: r.error || "" }));
      } else {
        formatError = r?.error || t("no se pudo formatear");
        UI.setError(t("⚠️ Sin formatear ({error}). El texto crudo está abajo y se guardó igual.", { error: formatError }));
      }
      UI.setResult(text);
    }

    if (settings.saveHistory) {
      JOB.phase(t("Guardando el .md…"), { steps: 0 });
      const s = await window.pill.historySave({
        kind: meta.kind || "file",
        sourceName: meta.sourceName || "audio",
        duration: meta.duration || 0,
        language: meta.language || "",
        text,
        // El crudo viaja siempre: history decide si lo guarda aparte (solo cuando
        // el texto principal fue formateado y difiere).
        rawText: raw,
        formatted, partial, failedCount, formatError,
      });
      if (s?.ok) UI.setSavedPath(s.path, s.rawPath);
      else UI.setError(t("⚠️ No se pudo guardar el .md: {error}", { error: s?.error || t("error desconocido") }));
    }

    return text;
  }

  // ---- Grabación de reuniones (dos pistas) ----
  // Los trozos se transcriben MIENTRAS la reunión sigue, así que al detener casi
  // todo el trabajo ya está hecho. Cada trozo transcripto se guarda con su pista y
  // su tiempo; al final se intercalan las dos pistas por tiempo.
  let meetLineas = { sistema: [], mic: [] };
  let meetPendientes = [];    // transcripciones lanzadas (promesas)
  let meetEnVuelo = 0;        // cuántas siguen sin terminar AHORA
  let meetCerrando = false;   // ya se detuvo: lo que queda es la cola final
  let meetColaFinal = 0;      // cuántas había pendientes al detener (para el %)
  let meetIdioma = "";
  let meetT0 = null;

  // Nombre de la reunión (sirve de título del trabajo y del .md guardado).
  function meetNombre() {
    const d = meetT0 || new Date();
    return t("Reunión {date} {time}", {
      date: d.toLocaleDateString("es-AR"),
      time: `${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`,
    });
  }

  // Lo que se muestra en el panel de la reunión mientras grabás: líneas ya
  // transcriptas y partes que están yendo a Groq en este momento. Sin esto, una
  // reunión larga se ve igual esté transcribiendo o esté trabada.
  function meetRefreshState() {
    if (!MT.isRecording()) return;
    const n = meetLineas.sistema.length + meetLineas.mic.length;
    const cola = meetEnVuelo
      ? " · " + t("{k} parte(s) transcribiéndose", { k: meetEnVuelo })
      : "";
    UI.setMeetingState(t("Grabando · {n} líneas transcriptas", { n }) + cola, true);
  }

  async function meetStart() {
    if (MT.isRecording()) return;

    // Confirmar antes de arrancar: se muestra de qué dispositivos se va a grabar,
    // porque descubrir a los 40 minutos que se capturó la salida equivocada no
    // tiene arreglo. Se puede apagar desde ⚙.
    if (settings.meetingConfirm !== false) {
      const dev = await MT.preview();
      const ok = await UI.askMeetConfirm(dev);
      if (!ok) return;
    }

    meetLineas = { sistema: [], mic: [] };
    meetPendientes = [];
    meetEnVuelo = 0;
    meetCerrando = false;
    meetColaFinal = 0;
    meetIdioma = "";
    meetT0 = new Date();

    UI.setError("");
    UI.setStatus(t("Pidiendo el audio del sistema…"));
    const r = await MT.start();
    if (!r.ok) { UI.setStatus(""); UI.setError(r.error); return; }

    UI.setMeetingUI(true, { hasMic: r.hasMic, salida: r.salida });
    UI.setStatus("");
  }

  async function meetStop() {
    if (!MT.isRecording()) return;
    const r = MT.stop();
    meetCerrando = true;
    UI.setMeetingState(t("Transcribiendo lo que falta…"));

    // A partir de acá puede haber varios minutos de trabajo (las últimas partes,
    // el formateo y el guardado). Todo eso va al panel de avance, que se ve con
    // cualquier panel abierto.
    JOB.start({
      kind: "meeting",
      title: `${meetNombre()} · ${UI.fmtDuration(r.duration || 0)}`,
    });
    JOB.phase(t("Cerrando la grabación…"));

    // Los últimos trozos salen por onChunk al parar los recorders: esperamos un
    // instante a que se encolen antes de esperar a que terminen todos.
    await new Promise((res) => setTimeout(res, 300));
    meetColaFinal = meetEnVuelo;
    if (meetColaFinal) {
      JOB.phase(t("Transcribiendo las últimas {n} parte(s)…", { n: meetColaFinal }),
        { steps: meetColaFinal, done: 0 });
    }
    await Promise.allSettled(meetPendientes);

    UI.setMeetingUI(false);
    JOB.phase(t("Uniendo las dos pistas…"), { steps: 0 });

    const segs = MT.merge(meetLineas);
    if (!segs.length) {
      JOB.finish("");
      UI.setError(t("No se reconoció nada en la reunión."));
      return;
    }

    // El texto lleva [mm:ss] y la pista (Reunión / Yo). No se inventa quién habla:
    // la etiqueta dice de qué dispositivo salió el audio.
    const crudo = MT.render(segs);
    UI.setResult(crudo);

    const nombre = meetNombre();
    const texto = await finishTranscript(
      // Una sola "parte": el transcript ya viene ordenado y con sus marcas.
      [{ text: crudo, start: 0, end: r.duration || 0 }],
      {
        sourceName: nombre,
        duration: r.duration || 0,
        language: meetIdioma,
        silences: [],
        kind: "meeting",
        // Las marcas de tiempo ya están en el texto: que el formateador no agregue
        // otra capa de encabezados encima.
        noTimestamps: true,
      }
    );
    UI.setResult(texto);
    JOB.finish(t("Listo — copiá el texto con 📋"));
  }

  // Cada trozo que cierra una pista se transcribe enseguida, en paralelo con la
  // grabación que sigue. Cada frase se guarda con su tiempo REAL en la reunión
  // (inicio del trozo + tiempo del segmento dentro del trozo): es lo que permite
  // intercalar las dos pistas en el orden en que se habló.
  function onMeetChunk(pista, blob, inicio) {
    meetEnVuelo++;
    meetRefreshState();
    const tarea = (async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = await TR.transcribeToText(bytes, "webm", "transcribe");
        if (!r || !r.text) return;
        if (!meetIdioma && r.language) meetIdioma = r.language;
        const segs = Array.isArray(r.segments) && r.segments.length
          ? r.segments.map((sg) => ({ start: inicio + sg.start, end: inicio + sg.end, text: sg.text }))
          // Sin segmentos (no debería pasar con verbose_json): las líneas heredan el
          // tiempo del trozo, ordenadas al menos entre sí.
          : r.text.split("\n").map((l) => ({ start: inicio, end: inicio, text: l.trim() }));
        for (const sg of segs) if (sg.text) meetLineas[pista].push(sg);
      } finally {
        meetEnVuelo--;
        meetRefreshState();
        // Ya se detuvo la reunión: lo que queda es la cola final, y ahí sí se
        // puede decir cuánto falta (cuántas partes de cuántas).
        if (meetCerrando && meetColaFinal) {
          const hechas = meetColaFinal - meetEnVuelo;
          JOB.phase(t("Transcribiendo las últimas partes… ({i} de {n})", { i: hechas, n: meetColaFinal }),
            { steps: meetColaFinal, done: hechas });
        }
      }
    })();
    meetPendientes.push(tarea);
  }

  MT.configure({
    getSettings: () => settings,
    onStatus: (m) => UI.setStatus(m),
    onError: (m) => UI.setError(m),
    onTick: (s) => UI.setMeetingTime(s),
    onLevel: (mic, sis) => UI.setMeetingLevels(mic, sis),
    onChunk: onMeetChunk,
  });

  // ---- Conectar el avance con la UI y con la bandeja ----
  // La bandeja recibe el mismo estado: con la píldora escondida (✕), el tooltip
  // del icono es la única forma de ver en qué anda sin volver a mostrarla.
  JOB.configure({
    onRender: (v) => {
      UI.setJob(v);
      // Trabajo terminado con la píldora escondida: un globo de Windows avisa.
      if (!v.active && v.final) window.pill?.jobDone(v.final);
    },
    onTray: (text) => window.pill?.jobStatus(text),
  });

  // ---- Conectar Transcription con la UI ----
  TR.configure({
    getSettings: () => settings,
    // Con un trabajo largo en curso, los avisos sueltos de Groq (reintento por
    // cuota, sin conexión) van a la segunda línea del panel de avance: la etapa
    // ("parte 3 de 12") tiene que seguir a la vista.
    onStatus: (m) => { if (JOB.isActive()) JOB.note(m); else UI.setStatus(m); },
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
    // ---- Historial ----
    onHistoryList: () => window.pill.historyList(),
    onHistoryOpenEntry: async (id) => {
      const r = await window.pill.historyRead(id);
      if (!r?.ok) { UI.setError(r?.error || t("No se pudo leer la transcripción.")); return; }
      UI.closeHistory();
      UI.setResult(r.text);
      UI.setStatus(t("Del historial: {title}", { title: r.entry?.title || "" }));
    },
    onHistoryOpenFile: async (id, which) => {
      const r = await window.pill.historyOpen(id, which);
      if (!r?.ok) UI.setError(r?.error || t("No se pudo abrir el archivo."));
    },
    onListModels: () => window.pill.listModels(),
    // ---- Sistema (config): versión, links, logs, updates, probar key ----
    onAppInfo: () => window.pill.appInfo(),
    onOpenExternal: (url) => window.pill.openExternal(url),
    onOpenLogs: async () => {
      const r = await window.pill.openLogs();
      if (!r?.ok) UI.setError(r?.error || t("No se pudo abrir la carpeta de logs."));
    },
    onCheckUpdate: () => window.pill.checkUpdate(),
    onTestConnection: (key) => TR.testKey(key),
    onHotkeysStatus: () => window.pill.hotkeysStatus(),
    // Avisos de arranque: marcar "no avisar más" / "ya lo vi".
    onDismissNotice: async (partial) => { settings = await window.pill.saveSettings(partial); },
    onFfmpegInstall: () => window.pill.ffmpegInstall(),
    onFfmpegRecheck: () => window.pill.ffmpegRecheck(),
    onHistoryReveal: (id) => window.pill.historyReveal(id),
    // Re-formatear desde el historial: el main formatea y reescribe el .md; acá
    // se muestra el avance (format:progress) y el resultado.
    onHistoryReformat: async (id) => {
      UI.closeHistory();
      UI.setError("");
      JOB.start({ kind: "file", title: t("Volver a formatear") });
      JOB.phase(t("Dando formato al texto…"), { fraction: 0 });
      const r = await window.pill.historyReformat(id);
      if (!r?.ok) { JOB.finish(""); UI.setError(r?.error || t("no se pudo formatear")); return; }
      UI.setResult(r.text);
      UI.setSavedPath(r.path, r.rawPath);
      JOB.finish(t("Formateado y guardado ✓"));
    },
    // La ✕ del historial borra de verdad: la UI ya pidió confirmación.
    onHistoryRemove: (id, alsoFile) => window.pill.historyRemove(id, !!alsoFile),
    onGetMeetingOutput: () => MT.preview().then((d) => d.salida),
    // ---- Carpeta de guardado ----
    onPickHistoryFolder: async () => {
      const r = await window.pill.historyPickFolder();
      return r?.ok ? r.folder : null;
    },
    // ---- Reuniones ----
    onMeetStart: () => meetStart(),
    onMeetStop: () => meetStop(),
    onMeetMute: (on) => MT.setMicMuted(on),
    onOpenHistoryFolder: async () => {
      const r = await window.pill.historyOpenFolder();
      if (!r?.ok) UI.setError(r?.error || t("No se pudo abrir la carpeta."));
    },
    onGetHistoryFolder: () => window.pill.historyFolder(),
    onGetFormatStatus: () => window.pill.formatStatus(),
    onRecheckFormat: () => window.pill.formatRecheck(),
    onTest: async (action) => {
      if (action === "show") {
        UI.setResult("Prueba VozLibre: áéíóú ñÑ ¿Está? ¡Sí! 123");
        UI.setStatus(t("Acción \"Solo mostrar\": el texto aparece acá ✓"));
        return;
      }
      if (UI.isConfigOpen()) UI.toggleConfig(); // cerrar para soltar el foco
      UI.setTestBusy(true);
      UI.setStatus(t("Enfocá tu app… (1,5 s)"));
      const r = await window.pill.testAction(action);
      UI.setTestBusy(false);
      if (r?.ok) UI.setStatus(action === "paste" ? t("Pegado (Ctrl+V) ✓") : t("Tecleado ✓"));
      else UI.setError(t("Falló: {error}", { error: r?.error || t("desconocido") }));
    },
  });

  // ---- Push-to-talk global (desde el main vía uiohook) ----
  // mantener = grabar, soltar = transcribir/traducir. A prueba de cruces: si ya hay
  // grabación, se ignora otro DOWN; y solo corta el UP cuyo modo coincide con el que
  // inició la grabación (no se mezcla español con inglés).
  let activeMode = null;
  window.pill.onPttDown((mode) => {
    if (UI.isConfigOpen() || TR.isRecording()) return;
    // Con una reunión grabando, el dictado se pelearía por el micrófono y además
    // el texto iría a parar a otra app en medio de la reunión.
    if (MT.isRecording()) { UI.setError(t("Hay una reunión grabando: el dictado está en pausa.")); return; }
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
      if (typeof p.progress === "number") JOB.fraction(p.progress);
      return;
    }
    if (p.stage === "silence") { JOB.phase(t("Buscando los silencios para cortar…")); return; }
    if (p.stage === "trim") { JOB.phase(t("Sacando los silencios…")); return; }
    if (p.stage === "split") { JOB.phase(t("Cortando en {n} partes…", { n: p.total })); return; }
  });

  // ---- Avance del formateo (una llamada al CLI por parte) ----
  window.pill.onFormatProgress((p) => {
    if (!p || !p.total) return;
    JOB.phase(
      p.total > 1 ? t("Dando formato ({i} de {n})…", { i: p.index + 1, n: p.total }) : t("Dando formato al texto…"),
      { steps: p.total, done: p.index }
    );
  });

  // ---- Avisos de arranque ----
  // Cosas que conviene saber antes del primer uso, cada una en su aviso (en cola,
  // nunca encima de la config):
  //   1. Atajos: si el hook de teclado no cargó, decirlo con el motivo.
  //   2. Sin API key: abrir la config con la bienvenida (es el único paso obligatorio).
  //   3. Sin ffmpeg: qué se pierde y un botón para instalarlo.
  //   4. Sin Claude CLI: qué se pierde (una sola vez).
  //   5. Versión nueva en GitHub.
  async function startupChecks() {
    try {
      const hk = await window.pill.hotkeysStatus();
      UI.setHotkeysStatus(hk);
      if (hk && !hk.ok) {
        log("error", `atajos: ${hk.error}`);
        UI.showNotice({
          title: t("⚠️ Los atajos globales no funcionan"),
          text: t("No se pudo activar el hook de teclado ({error}). Podés dictar igual manteniendo presionado el orbe 🔘 de la píldora, pero F8/F9 no van a responder desde otras apps.", { error: hk.error }),
          buttons: [{ label: t("Entendido") }],
        });
      }
    } catch (e) { log("error", `hotkeysStatus: ${e.message}`); }

    if (!settings.groqApiKey) UI.openOnboarding();

    try {
      const ff = await window.pill.ffmpegStatus();
      if (!ff?.available && !settings.ffmpegNoticeDismissed) showFfmpegNotice();
    } catch (e) { log("error", `ffmpegStatus: ${e.message}`); }

    try {
      const fs = await window.pill.formatStatus();
      // Con el CLI presente y el formateo prendido, probar que RESPONDA: un CLI
      // viejo o sin login se ve solo al llamarlo, y descubrirlo al final de una
      // reunión de una hora es tarde.
      if (fs?.available && settings.formatMarkdown) checkClaudeHealth(false);
      if (!fs?.available && !settings.claudeNoticeShown) {
        UI.showNotice({
          title: t("ℹ️ El formateo usa Claude Code (opcional)"),
          text: t("Para convertir las reuniones y los archivos transcriptos en texto con párrafos y puntuación, VozLibre usa Claude Code, que no está instalado. Sin él todo funciona igual, pero esos textos se guardan sin formatear (corridos). El dictado no se ve afectado."),
          buttons: [
            { label: t("Cómo instalarlo"), onClick: () => window.pill.openExternal("https://claude.com/claude-code"), keep: true },
            { label: t("Entendido"), primary: true },
          ],
          onClose: () => window.pill.saveSettings({ claudeNoticeShown: true }).then((s) => { settings = s; }),
        });
      }
    } catch (e) { log("error", `formatStatus: ${e.message}`); }

    // Versión nueva: se consulta en segundo plano; si falla, no molesta.
    setTimeout(async () => {
      try {
        const u = await window.pill.checkUpdate();
        if (u?.ok && u.available) showUpdateNotice(u);
      } catch (e) { log("warn", `update: ${e.message}`); }
    }, 4000);
  }

  async function checkClaudeHealth(force) {
    let h;
    try { h = await window.pill.formatHealth(force); }
    catch (e) { log("error", `formatHealth: ${e.message}`); return; }
    if (!h || h.ok) {
      if (force) UI.setStatus(t("Claude Code responde ✓"));
      return;
    }
    const versionIssue = /version .* required|does not support this model|claude update/i.test(h.error || "");
    UI.showNotice({
      title: t("⚠️ Claude Code está instalado pero no responde"),
      text: t("El formateo va a fallar y las transcripciones se guardarán sin formato hasta que se arregle. Motivo: {error}", { error: h.error }) +
        (versionIssue ? " " + t("Parece un problema de versión: abrí una terminal y corré `claude update` (o `npm i -g @anthropic-ai/claude-code@latest`).") : ""),
      buttons: [
        { label: t("Volver a probar"), primary: true, keep: true, onClick: async () => { UI.closeNotice(); await checkClaudeHealth(true); } },
        { label: t("Entendido") },
      ],
    });
  }

  function showFfmpegNotice() {
    UI.showNotice({
      title: t("ℹ️ Falta ffmpeg (opcional)"),
      text: t("Sin ffmpeg no se pueden transcribir videos ni audios de más de 25 MB. El dictado, las notas de voz y las reuniones funcionan igual. Se instala en un minuto con winget (se abre una ventana; puede pedir permisos)."),
      buttons: [
        {
          label: t("Instalar con winget"), primary: true, keep: true,
          onClick: async () => {
            const r = await window.pill.ffmpegInstall();
            if (!r?.ok) UI.setError(r?.error || t("No se pudo lanzar la instalación."));
            else UI.setStatus(t("Instalando ffmpeg en una ventana aparte…"));
          },
        },
        {
          label: t("Ya lo instalé, comprobar"), keep: true,
          onClick: async () => {
            const r = await window.pill.ffmpegRecheck();
            if (r?.available) { UI.closeNotice(); UI.setStatus(t("ffmpeg detectado ✓")); }
            else UI.setError(t("Todavía no se encuentra ffmpeg. Si lo acabás de instalar, cerrá y volvé a abrir VozLibre."));
          },
        },
        { label: t("No avisar más"), onClick: async () => { settings = await window.pill.saveSettings({ ffmpegNoticeDismissed: true }); } },
      ],
    });
  }

  function showUpdateNotice(u) {
    UI.showNotice({
      title: t("🔄 Hay una versión nueva: {latest}", { latest: u.latest }),
      text: t("Tenés la {current}. Descargá el nuevo .exe desde GitHub y reemplazá el actual; la configuración se conserva.", { current: u.current }),
      buttons: [
        { label: t("Descargar"), primary: true, onClick: () => window.pill.openExternal(u.downloadUrl || u.url) },
        { label: t("Después") },
      ],
    });
  }

  // ---- Init ----
  window.addEventListener("DOMContentLoaded", async () => {
    window.VLI18n.apply(document);
    UI.bindEvents();
    settings = await window.pill.loadSettings();
    UI.refreshLayout();
    startupChecks();
  });
})();
