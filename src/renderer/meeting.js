/* VozLibre2 — Grabación de reuniones (dos pistas)
 * ================================================
 * Graba lo que suena en la PC (Teams, Zoom, Meet, lo que sea) SIN depender de la
 * app: se capturan dos pistas por separado y eso da la separación de hablante sin
 * necesidad de diarización.
 *
 *   - "Reunión": loopback del audio del sistema = todos los demás.
 *   - "Yo":      el micrófono = vos.
 *
 * Quién habla no se adivina: sale de QUÉ DISPOSITIVO capturó cada palabra. Whisper
 * no diariza y no da nombres, así que las etiquetas son esas dos y nada más.
 *
 * El loopback captura lo que la app REPRODUCE, así que funciona con la PC en
 * silencio, con auriculares o sin parlantes conectados.
 *
 * Las dos pistas comparten una línea de tiempo (el reloj de la grabación), así que
 * al final se intercalan por tiempo para reconstruir la conversación.
 *
 * Se expone como window.VLMeeting. Lo consume renderer.js.
 */
(function () {
  // Trozos de 5 minutos: se transcriben mientras la reunión sigue, así al cortar
  // el transcript ya está casi listo. Además ningún trozo se acerca al límite de
  // tamaño de Groq.
  const CHUNK_MS = 5 * 60 * 1000;

  // Etiquetas de cada pista. No son nombres: son de dónde vino el audio.
  const LABELS = { sistema: "Reunión", mic: "Yo" };

  // Con parlantes abiertos el micrófono capta también a los demás, así que la misma
  // frase aparece en las dos pistas. La copia que llega después es el eco.
  const BLEED_WINDOW = 2.0;   // segundos entre las dos copias
  const MIN_ECHO_WORDS = 4;   // menos que esto es "sí", "dale": nunca se descarta

  let grabando = false;
  let pistas = [];          // [{ nombre, stream, recorder, trozos: [] }]
  let t0 = 0;               // marca de inicio (performance.now)
  let chunkTimer = null;   // cronómetro/medidores (setTimeout encadenado)
  let cortarTimer = null;  // corte de trozos cada CHUNK_MS (setInterval)
  let indice = 0;

  let cb = {
    getSettings: () => ({}),
    onStatus: () => {},
    onError: () => {},
    onTick: () => {},        // (segundos) para el cronómetro de la UI
    onLevel: () => {},       // (nivelMic, nivelSistema) medidores
    onChunk: () => {},       // (nombrePista, blob, inicioSeg, finSeg)
  };
  function configure(callbacks) { cb = { ...cb, ...callbacks }; }

  function isRecording() { return grabando; }
  function elapsed() { return grabando ? (performance.now() - t0) / 1000 : 0; }

  // ---------------------------------------------------------------------------
  // Abrir las pistas
  // ---------------------------------------------------------------------------

  // El audio del sistema llega por getDisplayMedia: el main responde al pedido con
  // audio "loopback" (ver ipc.js). Pedimos video porque Windows no entrega loopback
  // sin él, pero la pista de video se descarta enseguida: solo queremos el audio.
  async function abrirSistema() {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    st.getVideoTracks().forEach((t) => { t.stop(); st.removeTrack(t); });
    if (!st.getAudioTracks().length) {
      throw new Error("Windows no entregó el audio del sistema.");
    }
    return st;
  }

  /* Micrófono de la pista "Yo".
   *
   * Se prefiere meetingMicId (el que elegiste para reuniones) y se cae al del
   * dictado. Si el elegido ya no está (desconectaste los auriculares), se reintenta
   * con el del sistema en vez de quedarse sin la pista: grabar la reunión sin tu voz
   * es peor que grabarla con otro micrófono. */
  async function abrirMic() {
    const s = cb.getSettings();
    const preferido = s.meetingMicId || s.deviceId || "";
    if (preferido) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: preferido } },
        });
      } catch { /* ese micrófono ya no está: probamos con el del sistema */ }
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  /* Nombre del dispositivo de SALIDA que se va a capturar.
   *
   * getDisplayMedia captura siempre la salida por defecto de Windows y NO acepta
   * elegir otra (rechaza las constraints exactas). Así que no se puede seleccionar:
   * lo único honesto es decir cuál se está grabando, para que el usuario la cambie
   * en Windows si no es la que corresponde. */
  async function salidaActual() {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      const def = ds.find((d) => d.kind === "audiooutput" && d.deviceId === "default");
      // La etiqueta viene como "Default - Altavoces (X)": nos quedamos con el nombre.
      if (def?.label) return def.label.replace(/^Default\s*-\s*/i, "");
      const primero = ds.find((d) => d.kind === "audiooutput");
      return primero?.label || "";
    } catch {
      return "";
    }
  }

  /* Nombre del micrófono que se usaría, para mostrarlo en la confirmación. */
  async function micActual() {
    const s = cb.getSettings();
    const id = s.meetingMicId || s.deviceId || "";
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      const ins = ds.filter((d) => d.kind === "audioinput");
      const elegido = id ? ins.find((d) => d.deviceId === id) : null;
      if (elegido) return elegido.label;
      const def = ins.find((d) => d.deviceId === "default");
      return (def?.label || ins[0]?.label || "").replace(/^Default\s*-\s*/i, "");
    } catch {
      return "";
    }
  }

  /* Qué se va a grabar, para el popup de confirmación. */
  async function preview() {
    const [salida, mic] = await Promise.all([salidaActual(), micActual()]);
    return { salida, mic };
  }

  // Medidor de nivel por pista, para que la UI muestre que algo está entrando.
  function medidor(stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      return {
        ctx,
        nivel() {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          return Math.min(1, Math.sqrt(sum / buf.length) * 6);
        },
      };
    } catch {
      return { ctx: null, nivel: () => 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Grabar
  // ---------------------------------------------------------------------------

  /* Arranca la grabación. Devuelve las pistas que se pudieron abrir.
   *
   * El micrófono es opcional: si no está, igual se graba la reunión (solo que sin
   * lo que vos digas). El audio del sistema NO es opcional: sin él no hay reunión
   * que grabar. */
  async function start() {
    if (grabando) return { ok: false, error: "Ya hay una grabación en curso." };
    const s = cb.getSettings();
    if (!s.groqApiKey) return { ok: false, error: "Falta la API key de Groq. Abrí ⚙ y pegala." };

    let sistema;
    try {
      sistema = await abrirSistema();
    } catch (e) {
      // Cancelar el diálogo de compartir pantalla es lo más común acá.
      const cancelado = /Permission denied|NotAllowed/i.test(e.name + e.message);
      return {
        ok: false,
        error: cancelado
          ? "Cancelaste la captura. Para grabar hay que compartir una pantalla (solo se usa el audio)."
          : "No se pudo capturar el audio del sistema: " + e.message,
      };
    }

    let mic = null;
    try { mic = await abrirMic(); }
    catch { /* seguimos sin micrófono: se graba solo la reunión */ }

    t0 = performance.now();
    indice = 0;
    pistas = [];

    for (const [nombre, stream] of [["sistema", sistema], ["mic", mic]]) {
      if (!stream) continue;
      const rec = new MediaRecorder(stream, elegirMime());
      const p = { nombre, stream, recorder: rec, trozos: [], medidor: medidor(stream) };
      rec.ondataavailable = (e) => { if (e.data.size > 0) p.trozos.push(e.data); };
      // Cada vez que el recorder para (por corte de trozo o por fin), se entrega
      // lo acumulado y se limpia para el trozo siguiente.
      rec.onstop = () => entregarTrozo(p);
      pistas.push(p);
    }

    if (!pistas.length) {
      sistema.getTracks().forEach((t) => t.stop());
      return { ok: false, error: "No se pudo abrir ninguna pista de audio." };
    }

    // Si el usuario corta la compartición desde la barra de Windows, la pista de
    // sistema muere: hay que cerrar la grabación en vez de seguir grabando nada.
    sistema.getAudioTracks().forEach((t) => {
      t.addEventListener("ended", () => {
        if (grabando) stop({ motivo: "Se cortó la captura del audio del sistema." });
      });
    });

    grabando = true;
    pistas.forEach((p) => p.recorder.start());
    arrancarTimers();

    // El label real de la pista de mic: si el elegido no estaba, acá se ve cuál
    // quedó de verdad (no el que se pidió).
    const micLabel = mic ? (mic.getAudioTracks()[0]?.label || "") : "";
    return {
      ok: true,
      tracks: pistas.map((p) => LABELS[p.nombre]),
      hasMic: !!mic,
      micLabel,
      salida: await salidaActual(),
    };
  }

  // webm/opus es lo que Chromium graba nativo y Groq acepta. Si el navegador no lo
  // soporta se cae al default del MediaRecorder.
  function elegirMime() {
    for (const t of ["audio/webm;codecs=opus", "audio/webm"]) {
      if (MediaRecorder.isTypeSupported(t)) return { mimeType: t };
    }
    return {};
  }

  function arrancarTimers() {
    // Cronómetro + medidores para la UI.
    const tick = () => {
      if (!grabando) return;
      cb.onTick(elapsed());
      const niveles = {};
      for (const p of pistas) niveles[p.nombre] = p.medidor.nivel();
      cb.onLevel(niveles.mic || 0, niveles.sistema || 0);
      chunkTimer = setTimeout(tick, 250);
    };
    tick();

    // Corte de trozos: parar y volver a arrancar cada recorder. Es la forma
    // confiable de obtener un archivo webm válido y completo por trozo (los datos
    // sueltos de un timeslice no llevan cabecera y Whisper no los acepta).
    cortarTimer = setInterval(() => {
      if (!grabando) return;
      for (const p of pistas) {
        if (p.recorder.state === "recording") p.recorder.stop();
      }
      // El onstop entrega el trozo; volver a arrancar en el próximo turno del loop
      // para que el evento llegue primero.
      setTimeout(() => {
        if (!grabando) return;
        indice++;
        for (const p of pistas) {
          if (p.recorder.state === "inactive") p.recorder.start();
        }
      }, 0);
    }, CHUNK_MS);
  }


  // Entrega un trozo terminado al orquestador, con su ubicación en la línea de
  // tiempo de la reunión.
  function entregarTrozo(p) {
    if (!p.trozos.length) return;
    const blob = new Blob(p.trozos, { type: p.recorder.mimeType || "audio/webm" });
    p.trozos = [];
    const inicio = indice * (CHUNK_MS / 1000);
    const fin = inicio + (CHUNK_MS / 1000);
    if (blob.size > 0) cb.onChunk(p.nombre, blob, inicio, Math.min(fin, elapsed()));
  }

  /* Corta la grabación y devuelve la duración total. Los trozos finales salen por
   * onChunk igual que los demás (vía onstop). */
  function stop(opts = {}) {
    if (!grabando) return { ok: false };
    const total = elapsed();
    grabando = false;

    clearTimeout(chunkTimer);
    clearInterval(cortarTimer);
    chunkTimer = cortarTimer = null;

    for (const p of pistas) {
      try { if (p.recorder.state === "recording") p.recorder.stop(); } catch { /* ya parado */ }
    }
    // Cerrar streams y contextos de audio después de que los onstop hayan corrido.
    setTimeout(() => {
      for (const p of pistas) {
        p.stream.getTracks().forEach((t) => t.stop());
        try { p.medidor.ctx?.close(); } catch { /* ya cerrado */ }
      }
      pistas = [];
    }, 100);

    cb.onLevel(0, 0);
    if (opts.motivo) cb.onError(opts.motivo);
    return { ok: true, duration: total };
  }

  // ---------------------------------------------------------------------------
  // Unir las dos pistas en un transcript
  // ---------------------------------------------------------------------------

  /* Intercala las líneas de ambas pistas por tiempo y saca los ecos.
   *
   *   porPista: { sistema: [{start, end, text}], mic: [...] }
   *
   * Con parlantes abiertos la misma frase llega a las dos pistas. La copia que
   * aparece DESPUÉS es el eco — pero solo se descarta si no aporta nada: una línea
   * puede traer eco Y palabras que la otra pista no escuchó.
   */
  function merge(porPista) {
    const segs = [];
    for (const [pista, items] of Object.entries(porPista || {})) {
      const speaker = LABELS[pista] || pista;
      for (const s of items || []) {
        const text = (s.text || "").trim();
        if (text) segs.push({ t: +(s.start || 0).toFixed(2), speaker, text });
      }
    }
    segs.sort((a, b) => a.t - b.t);

    const plano = (t) =>
      t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

    const salida = [];
    const planos = [];
    for (const seg of segs) {
      const ult = salida[salida.length - 1];
      // Repetición exacta y consecutiva de la misma pista: duplicado, no eco.
      if (ult && ult.speaker === seg.speaker && ult.text === seg.text) continue;

      const p = plano(seg.text);
      const esEco =
        p.split(" ").length >= MIN_ECHO_WORDS &&
        salida.some(
          (ant, i) =>
            ant.speaker !== seg.speaker &&
            seg.t - ant.t <= BLEED_WINDOW &&
            planos[i].includes(p)
        );
      if (esEco) continue;

      salida.push(seg);
      planos.push(p);
    }
    return salida;
  }

  // Texto plano con marca de tiempo y hablante, listo para formatear o guardar.
  function render(segs) {
    const reloj = (s) => {
      const t = Math.floor(s);
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      const pad = (n) => String(n).padStart(2, "0");
      return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    };
    return segs.map((s) => `[${reloj(s.t)}] ${s.speaker}: ${s.text}`).join("\n");
  }

  window.VLMeeting = {
    configure, start, stop, isRecording, elapsed, merge, render, preview,
    LABELS, CHUNK_MS,
    // expuestos para tests
    _merge: merge,
  };
})();
