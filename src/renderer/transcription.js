/* VozLibre2 — Grabación + llamada a la API (Groq Whisper)
 * =======================================================
 * Captura audio del micrófono (MediaRecorder), detecta silencio para no gastar API,
 * y envía el audio a Groq Whisper:
 *   - modo "transcribe" -> /audio/transcriptions  (idioma de la config).
 *   - modo "translate"  -> /audio/translations    (traduce SIEMPRE a inglés).
 *
 * No toca el DOM: recibe callbacks (onStatus/onError/onText) y se le pasa la config
 * actual. Se expone como window.VLTranscription (el renderer no usa require por
 * contextIsolation). Lo consume renderer.js.
 */
(function () {
  const t = window.VLI18n.t;
  const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
  // Traducir usa SIEMPRE este modelo: es el único de Groq que soporta
  // /audio/translations. Para transcribir manda el de la config (settings.model),
  // que por defecto es el turbo: misma calidad en la práctica, más rápido y gasta
  // menos cuota — en push-to-talk la diferencia se nota.
  const TRANSLATE_MODEL = "whisper-large-v3";
  const DEFAULT_MODEL = "whisper-large-v3-turbo";

  // Umbral de silencio (RMS normalizado): por debajo se considera ruido de fondo.
  const SILENCE_THRESHOLD = 0.012;

  // ---- Filtro de alucinaciones de Whisper ----
  // Sobre silencio o ruido, Whisper INVENTA texto con total seguridad: "Gracias por
  // ver el video", despedidas que nadie dijo, frases en otro idioma sobre ruido de
  // sala. Cada segmento viene con un puntaje de confianza y los malos se descartan.
  //
  // Los umbrales están medidos, no elegidos a ojo: las invenciones puntúan entre
  // -0.68 y -1.60, mientras que habla real por una línea mala llega a -0.55. Un
  // corte en -0.5 se come habla legítima (incluidas cifras), así que va en -0.6.
  // no_speech_prob NO sirve como señal: da 0.0000 hasta en invenciones puras.
  const MIN_AVG_LOGPROB = -0.6;
  const MAX_NO_SPEECH = 0.6;

  // Hueco entre palabras que corta línea. Con timestamps por palabra sabemos dónde
  // estuvo cada silencio de verdad, sin tener que estimarlo.
  const WORD_GAP = 1.5;

  // Traduce un tiempo del audio SUBIDO al tiempo del audio ORIGINAL, deshaciendo el
  // silencio que se recortó antes de subir (ver audio.js:trimSilence). Sin esto los
  // timestamps quedan corridos por todo lo que se sacó.
  function toRealTime(t, mapping) {
    if (!mapping || !mapping.length) return t;
    for (const m of mapping) {
      if (t < m.at + m.len) return m.real + Math.max(0, t - m.at);
    }
    const last = mapping[mapping.length - 1];
    return last.real + last.len;
  }

  // Esperas ante 429/5xx. El free tier de Groq son 7.200 s de audio por hora: un
  // video largo lo toca. Sin reintento, la parte 7 de 12 se lleva puesto todo lo
  // que sigue; con esto solo tarda más.
  const RETRY_WAITS = [5000, 15000, 45000];

  // ---- Errores de la API en castellano ----
  // Un 401 crudo de Groq es un JSON en inglés que no le dice nada a quien acaba
  // de pegar mal la key. Los casos típicos se traducen a algo accionable; el
  // detalle técnico va al log, no a la píldora.
  function apiErrorMessage(status, body) {
    let detail = "";
    try { detail = JSON.parse(body)?.error?.message || ""; }
    catch { detail = String(body || "").replace(/\s+/g, " ").trim().slice(0, 200); }
    if (status === 401) return t("La API key de Groq no es válida (o fue revocada). Revisala en ⚙.");
    if (status === 403) return t("La API key no tiene permiso para usar este modelo.");
    if (status === 413) return t("El audio es demasiado grande para Groq (máximo 25 MB).");
    if (status === 429) return t("Se agotó la cuota de Groq por ahora. Esperá unos minutos o revisá tus límites en console.groq.com.");
    if (status >= 500) return t("Groq no responde (error {status}). Probá de nuevo en unos minutos.", { status });
    if (status === 400 && detail) return t("Groq rechazó el pedido: {detail}", { detail });
    return t("Error de Groq (HTTP {status}): {detail}", { status, detail: detail || t("sin detalle") });
  }
  const NETWORK_ERROR = () => t("Sin conexión con Groq. Revisá tu internet.");

  // MIME por extensión, para los audios que llegan desde un archivo.
  const MIME_BY_EXT = {
    ogg: "audio/ogg", opus: "audio/ogg", oga: "audio/ogg",
    m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", mpga: "audio/mpeg", mpeg: "audio/mpeg",
    wav: "audio/wav", webm: "audio/webm", flac: "audio/flac",
  };

  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let recordMode = "transcribe";

  // Monitor de volumen (Web Audio) para saber si hubo voz.
  let audioCtx = null, analyser = null, volRaf = null, hadVoice = false;

  // Callbacks/inyecciones que provee el orquestador (renderer.js).
  let cb = {
    getSettings: () => ({}),       // devuelve la config actual
    onStatus: () => {},            // (msg) cambio de estado/texto de la barra
    onError: () => {},             // (msg) error visible
    onText: () => {},              // (text, mode) texto reconocido -> aplicar acción
    onRecordingChange: () => {},   // (bool) para que la UI prenda/apague el orbe y timer
    onLevel: () => {},             // (level 0..1, voice bool) nivel de audio en vivo
  };
  function configure(callbacks) { cb = { ...cb, ...callbacks }; }

  function isRecording() { return recording; }

  // Reusa el stream; si cambió el micrófono, el orquestador llama releaseStream().
  async function getStream() {
    if (stream) return stream;
    const s = cb.getSettings();
    const constraints = s.deviceId
      ? { audio: { deviceId: { exact: s.deviceId } } }
      : { audio: true };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    return stream;
  }
  function releaseStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  function startVolumeMonitor(s) {
    hadVoice = false;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const voice = rms > SILENCE_THRESHOLD;
        if (voice) hadVoice = true;
        // Nivel normalizado a 0..1 para la UI. El RMS de voz normal ronda 0.02–0.2,
        // así que escalamos por ~6x y recortamos; queda un medidor que "responde".
        cb.onLevel(Math.min(1, rms * 6), voice);
        volRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch { hadVoice = true; } // si falla el análisis, no bloqueamos
  }
  function stopVolumeMonitor() {
    if (volRaf) cancelAnimationFrame(volRaf);
    volRaf = null;
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    audioCtx = null; analyser = null;
    cb.onLevel(0, false); // apagar el medidor al parar
  }

  async function start(mode = "transcribe") {
    if (recording) return;
    const s = cb.getSettings();
    if (!s.groqApiKey) { cb.onError(t("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala.")); return; }
    try {
      const media = await getStream();
      chunks = [];
      recordMode = mode;
      mediaRecorder = new MediaRecorder(media);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = handleStop;
      mediaRecorder.start();
      startVolumeMonitor(media);
      recording = true;
      cb.onRecordingChange(true);
      cb.onStatus(mode === "translate" ? t("Grabando (→ inglés)… soltá para traducir") : t("Grabando… soltá para transcribir"));
    } catch (e) {
      cb.onError(t("Sin micrófono: {msg}", { msg: e.message }));
    }
  }

  function stop() {
    if (!recording || !mediaRecorder) return;
    recording = false;
    stopVolumeMonitor();
    cb.onRecordingChange(false);
    cb.onStatus(t("Procesando…"));
    mediaRecorder.stop();
  }

  async function handleStop() {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
    if (blob.size === 0) { cb.onStatus(""); cb.onError(t("No se grabó audio. Probá de nuevo.")); return; }
    if (!hadVoice) { cb.onStatus(""); cb.onError(t("🔇 No se detectó voz (no se gastó API).")); return; }
    await sendToGroq(blob, recordMode);
  }

  // Transcribe un audio que YA existe (archivo elegido con 📎 o soltado en la
  // píldora). Salta la grabación y el detector de silencio: el usuario eligió el
  // archivo a propósito, así que se manda tal cual por el mismo camino que el micro.
  //   bytes: Uint8Array del archivo | ext: extensión real ("ogg", "m4a", …)
  async function transcribeFile(bytes, ext, mode = "transcribe") {
    if (recording) { cb.onError(t("Esperá a que termine la grabación en curso.")); return; }
    const s = cb.getSettings();
    if (!s.groqApiKey) { cb.onError(t("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala.")); return; }
    // El tipo MIME solo orienta al servidor; el nombre con la extensión real es lo
    // que Whisper usa para decidir el decoder, y ese lo fijamos en sendToGroq.
    const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] || "application/octet-stream" });
    await sendToGroq(blob, mode, ext, true /* fromFile */);
  }

  // Llamada cruda a Groq. Devuelve el texto reconocido o lanza.
  // forceExt: extensión real cuando el audio viene de un archivo (el blob grabado
  // no la trae y hay que deducirla del mimeType del MediaRecorder).
  // Devuelve { text, language, segments }:
  //   - language: el idioma que Whisper DETECTÓ en el audio (código ISO: "en",
  //     "es"…), no el que pedimos. Sirve para avisar cuando el audio no era el
  //     idioma configurado y para que el formateador no traduzca.
  //   - segments: [{start, end, text}] ya filtrados de invenciones y en tiempo
  //     REAL del audio. Las reuniones los usan para ubicar cada frase en la línea
  //     de tiempo (sin esto todas las frases de un trozo caerían en el mismo
  //     instante y las dos pistas no se podrían intercalar).
  async function callGroq(blob, mode, forceExt, mapping = null) {
    const s = cb.getSettings();
    const translate = mode === "translate";
    const ext = forceExt || (blob.type.includes("ogg") ? "ogg" : "webm");
    const form = new FormData();
    form.append("file", blob, "audio." + ext);
    form.append("model", translate ? TRANSLATE_MODEL : (s.model || DEFAULT_MODEL));
    // verbose_json en vez de json: trae el idioma detectado. Mismo costo.
    form.append("response_format", "verbose_json");
    // temperature 0: sin esto Whisper "se relaja" y alucina más sobre audio dudoso.
    form.append("temperature", "0");
    // Los SEGMENTOS traen los puntajes de calidad (para descartar invenciones) y
    // las PALABRAS traen los tiempos finos (para cortar líneas en las pausas
    // reales). Se piden los dos: es un parámetro más, no una llamada más.
    // Solo en /audio/transcriptions: el endpoint de translations rechaza el
    // parámetro con un 400 (unknown param). Allá nos quedamos con los segmentos
    // que verbose_json ya trae, y cleanSegments corta sin tiempos por palabra.
    if (!translate) {
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }
    // El endpoint de translations sale SIEMPRE en inglés (no se manda 'language').
    //
    // OJO con 'language': no es una pista, es una ORDEN. Whisper devuelve el texto
    // en el idioma pedido, así que con lang="es" un audio en inglés vuelve
    // TRADUCIDO al español. Por eso solo se manda si el usuario eligió un idioma a
    // propósito; con "" (default) Whisper detecta y transcribe literal.
    if (!translate && s.lang) form.append("language", s.lang);

    const endpoint = translate ? "/audio/translations" : "/audio/transcriptions";
    const data = await postWithRetry(GROQ_BASE_URL + endpoint, s.groqApiKey, form);

    // Texto limpio de invenciones. Si el filtrado deja todo afuera nos quedamos con
    // data.text: preferimos texto de calidad dudosa a devolver nada.
    const limpio = cleanSegments(data, mapping);
    return {
      text: limpio || (data.text || "").trim(),
      // translations siempre sale en inglés, sea cual sea el audio de entrada.
      language: translate ? "en" : (data.language || ""),
      segments: goodSegments(data, mapping),
    };
  }

  // POST con reintentos ante 429 (cuota) y 5xx (fallo transitorio del servidor).
  // Los 4xx restantes son errores nuestros (key inválida, formato) y no se reintentan.
  async function postWithRetry(url, apiKey, form) {
    for (let intento = 0; ; intento++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Authorization": "Bearer " + apiKey },
          body: form,
        });
      } catch (e) {
        // Fallo de red: reintentable.
        window.pill?.log("warn", `groq: fallo de red (${e.message})`);
        if (intento >= RETRY_WAITS.length) throw new Error(NETWORK_ERROR());
        await esperar(RETRY_WAITS[intento], intento, t("sin conexión"));
        continue;
      }
      if (res.ok) return res.json();

      const reintentable = res.status === 429 || res.status >= 500;
      const detalle = await res.text();
      // El detalle técnico va al log (para soporte); a la píldora va el mensaje claro.
      window.pill?.log("error", `groq HTTP ${res.status}: ${detalle.slice(0, 500)}`);
      if (!reintentable || intento >= RETRY_WAITS.length) {
        throw new Error(apiErrorMessage(res.status, detalle));
      }
      // Groq puede indicar cuánto esperar; si lo dice, le hacemos caso.
      const ra = Number(res.headers.get("retry-after"));
      const espera = Number.isFinite(ra) && ra > 0 ? ra * 1000 : RETRY_WAITS[intento];
      await esperar(espera, intento, res.status === 429 ? t("límite de cuota") : t("error {status}", { status: res.status }));
    }
  }

  function esperar(ms, intento, motivo) {
    const seg = Math.ceil(ms / 1000);
    cb.onStatus(t("Groq: {motivo}. Reintentando en {seg} s… ({i}/{n})", { motivo, seg, i: intento + 1, n: RETRY_WAITS.length }));
    return new Promise((r) => setTimeout(r, ms));
  }

  // "Probar conexión" de la config: una llamada mínima (listar modelos) con la
  // key que está en el campo, sin guardarla. Devuelve {ok} | {ok:false, error}.
  async function testKey(key) {
    const k = (key || "").trim();
    if (!k) return { ok: false, error: t("Pegá una API key primero.") };
    let res;
    try {
      res = await fetch(GROQ_BASE_URL + "/models", { headers: { "Authorization": "Bearer " + k } });
    } catch {
      return { ok: false, error: NETWORK_ERROR() };
    }
    if (res.ok) return { ok: true };
    const body = await res.text();
    window.pill?.log("warn", `groq test HTTP ${res.status}: ${body.slice(0, 300)}`);
    return { ok: false, error: apiErrorMessage(res.status, body) };
  }

  // Arma el texto descartando los segmentos que Whisper inventó, y cortando línea
  // donde hubo una pausa real entre palabras.
  function cleanSegments(data, mapping = null) {
    const segments = data.segments || [];
    if (!segments.length) return "";

    const malo = (s) =>
      !(s.text || "").trim() ||
      (s.no_speech_prob ?? 0) > MAX_NO_SPEECH ||
      (s.avg_logprob ?? 0) < MIN_AVG_LOGPROB;

    const buenos = segments.filter((s) => !malo(s));
    if (!buenos.length) return "";

    const words = data.words || [];
    // Sin timestamps por palabra: al menos filtramos los segmentos inventados.
    if (!words.length) return buenos.map((s) => (s.text || "").trim()).join(" ").trim();

    // Se descarta por los rangos RECHAZADOS, no por los aceptados: una palabra que
    // cae en el hueco entre dos segmentos no pertenece a ninguno y se perdería.
    const rechazados = segments.filter(malo).map((s) => [s.start, s.end]);

    const lineas = [];
    let fin = null;
    for (const w of words) {
      const t = (w.word || "").trim();
      if (!t) continue;
      // El rechazo se evalúa en tiempos del audio SUBIDO (que es a lo que se
      // refieren los segmentos), pero el hueco entre palabras se mide en tiempo
      // REAL: si no, el silencio recortado desaparece y las frases que estaban
      // separadas por una pausa larga quedan pegadas.
      if (rechazados.some(([a, b]) => w.start >= a && w.start <= b)) continue;
      const inicio = toRealTime(w.start, mapping);
      // Hueco grande = pausa real en el audio: corta línea.
      if (fin !== null && inicio - fin <= WORD_GAP) lineas[lineas.length - 1] += " " + t;
      else lineas.push(t);
      fin = toRealTime(w.end, mapping);
    }
    return lineas.join("\n").trim();
  }

  // Segmentos buenos (sin invenciones) con sus tiempos en el audio REAL. Mismo
  // criterio de descarte que cleanSegments; acá interesa DÓNDE cae cada frase, no
  // armar el texto. Si el filtro deja todo afuera se devuelven todos: mejor una
  // frase dudosa ubicada que una reunión sin frases.
  function goodSegments(data, mapping = null) {
    const segments = data.segments || [];
    const conTexto = segments.filter((s) => (s.text || "").trim());
    const buenos = conTexto.filter((s) =>
      (s.no_speech_prob ?? 0) <= MAX_NO_SPEECH && (s.avg_logprob ?? 0) >= MIN_AVG_LOGPROB);
    return (buenos.length ? buenos : conTexto).map((s) => ({
      start: toRealTime(s.start || 0, mapping),
      end: toRealTime(s.end || 0, mapping),
      text: (s.text || "").trim(),
    }));
  }

  // fromFile: el audio venía de un archivo, no del micrófono. Viaja hasta onText
  // para que el orquestador no aplique pegar/teclear sobre la app de atrás.
  async function sendToGroq(blob, mode, forceExt, fromFile = false) {
    const translate = mode === "translate";
    cb.onStatus(translate ? t("Traduciendo a inglés con Groq…") : t("Transcribiendo con Groq…"));
    try {
      const { text, language } = await callGroq(blob, mode, forceExt);
      // await: onText aplica la acción (pegar/teclear) y puede tardar. Esperarlo
      // hace que sendToGroq no resuelva antes de que la acción termine, para que
      // quien llama sepa cuándo terminó de verdad todo el flujo.
      await cb.onText(text, mode, { fromFile, language });
    } catch (e) {
      cb.onError(e.message);
      cb.onStatus("");
    }
  }

  // Transcribe UN trozo y DEVUELVE {text, language, segments} (null si falló), sin tocar el
  // estado ni disparar onText. Lo usa el orquestador para los archivos partidos en
  // chunks: necesita ir juntando el texto y manejar el avance por su cuenta.
  //
  // mapping: cuando al trozo se le recortaron los silencios, traduce los tiempos
  // del audio subido a los del audio original (ver audio.js:trimSilence).
  async function transcribeToText(bytes, ext, mode = "transcribe", mapping = null) {
    const s = cb.getSettings();
    if (!s.groqApiKey) { cb.onError(t("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala.")); return null; }
    const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] || "application/octet-stream" });
    try {
      return await callGroq(blob, mode, ext, mapping);
    } catch (e) {
      cb.onError(e.message);
      return null;
    }
  }

  window.VLTranscription = {
    configure, start, stop, isRecording, releaseStream,
    transcribeFile, transcribeToText, testKey,
    // expuestos para tests
    _apiErrorMessage: apiErrorMessage,
    _cleanSegments: cleanSegments,
    _goodSegments: goodSegments,
    _toRealTime: toRealTime,
  };
})();
