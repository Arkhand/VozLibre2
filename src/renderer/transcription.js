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
  const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
  const MODEL = "whisper-large-v3"; // único modelo de Groq que también traduce

  // Umbral de silencio (RMS normalizado): por debajo se considera ruido de fondo.
  const SILENCE_THRESHOLD = 0.012;

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
    if (!s.groqApiKey) { cb.onError("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala."); return; }
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
      cb.onStatus(mode === "translate" ? "Grabando (→ inglés)… soltá para traducir" : "Grabando… soltá para transcribir");
    } catch (e) {
      cb.onError("Sin micrófono: " + e.message);
    }
  }

  function stop() {
    if (!recording || !mediaRecorder) return;
    recording = false;
    stopVolumeMonitor();
    cb.onRecordingChange(false);
    cb.onStatus("Procesando…");
    mediaRecorder.stop();
  }

  async function handleStop() {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
    if (blob.size === 0) { cb.onStatus(""); cb.onError("No se grabó audio. Probá de nuevo."); return; }
    if (!hadVoice) { cb.onStatus(""); cb.onError("🔇 No se detectó voz (no se gastó API)."); return; }
    await sendToGroq(blob, recordMode);
  }

  // Transcribe un audio que YA existe (archivo elegido con 📎 o soltado en la
  // píldora). Salta la grabación y el detector de silencio: el usuario eligió el
  // archivo a propósito, así que se manda tal cual por el mismo camino que el micro.
  //   bytes: Uint8Array del archivo | ext: extensión real ("ogg", "m4a", …)
  async function transcribeFile(bytes, ext, mode = "transcribe") {
    if (recording) { cb.onError("Esperá a que termine la grabación en curso."); return; }
    const s = cb.getSettings();
    if (!s.groqApiKey) { cb.onError("⚠️ Falta tu API key de Groq. Abrí ⚙ y pegala."); return; }
    // El tipo MIME solo orienta al servidor; el nombre con la extensión real es lo
    // que Whisper usa para decidir el decoder, y ese lo fijamos en sendToGroq.
    const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] || "application/octet-stream" });
    await sendToGroq(blob, mode, ext, true /* fromFile */);
  }

  // forceExt: extensión real cuando el audio viene de un archivo (el blob grabado
  // no la trae y hay que deducirla del mimeType del MediaRecorder).
  // fromFile: el audio venía de un archivo, no del micrófono. Viaja hasta onText
  // para que el orquestador no aplique pegar/teclear sobre la app de atrás.
  async function sendToGroq(blob, mode, forceExt, fromFile = false) {
    const s = cb.getSettings();
    const translate = mode === "translate";
    cb.onStatus(translate ? "Traduciendo a inglés con Groq…" : "Transcribiendo con Groq…");
    const ext = forceExt || (blob.type.includes("ogg") ? "ogg" : "webm");
    const form = new FormData();
    form.append("file", blob, "audio." + ext);
    form.append("model", MODEL);
    form.append("response_format", "json");
    // El endpoint de translations sale SIEMPRE en inglés (no se manda 'language').
    if (!translate && s.lang) form.append("language", s.lang);

    const endpoint = translate ? "/audio/translations" : "/audio/transcriptions";
    try {
      const res = await fetch(GROQ_BASE_URL + endpoint, {
        method: "POST",
        headers: { "Authorization": "Bearer " + s.groqApiKey },
        body: form,
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " — " + (await res.text()));
      const data = await res.json();
      // await: onText aplica la acción (pegar/teclear) y puede tardar. Esperarlo
      // hace que sendToGroq no resuelva antes de que la acción termine, para que
      // quien llama sepa cuándo terminó de verdad todo el flujo.
      await cb.onText((data.text || "").trim(), mode, { fromFile });
    } catch (e) {
      cb.onError("Error: " + e.message);
      cb.onStatus("");
    }
  }

  window.VLTranscription = { configure, start, stop, isRecording, releaseStream, transcribeFile };
})();
