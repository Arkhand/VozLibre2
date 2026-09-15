/* VozLibre2 — Trabajo en curso (estado de avance)
 * ================================================
 * Un archivo de una hora o una reunión larga tardan minutos: sin un indicador
 * claro, la píldora parece colgada y no hay forma de saber si falta poco o mucho.
 * Acá vive ESE estado, en un solo lugar:
 *
 *   - qué se está haciendo (la etapa: convertir, transcribir, formatear, guardar),
 *   - por dónde va (parte 3 de 12, 45 %),
 *   - cuánto lleva y cuánto falta (estimado con lo que tardaron las partes ya hechas),
 *   - el último aviso suelto (un reintento de Groq, por ejemplo).
 *
 * Es estado PURO: no toca el DOM ni la API. La UI se suscribe con configure({onRender})
 * y dibuja lo que devuelve view(); el main recibe trayText() para el tooltip de la
 * bandeja (así el avance también se ve con la píldora escondida).
 *
 * El reloj corre solo (un tick por segundo) mientras haya un trabajo activo: el
 * "transcurrido" se mueve aunque la etapa tarde, que es lo que distingue "está
 * trabajando" de "se colgó".
 *
 * Se expone como window.VLProgress. Lo consumen ui.js (dibujo) y renderer.js (flujos).
 */
(function () {
  const t = window.VLI18n.t;

  // Estado del trabajo en curso. null = no hay nada corriendo.
  let job = null;
  let tickId = null;

  let cb = {
    onRender: null,   // (view) la UI dibuja
    onTray: null,     // (trayText|"") el main actualiza el tooltip de la bandeja
    now: () => Date.now(),
  };
  function configure(callbacks) { cb = { ...cb, ...callbacks }; }

  // ---------------------------------------------------------------------------
  // Formato de tiempos
  // ---------------------------------------------------------------------------
  function clockText(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  // Lo que falta, redondeado hacia arriba: una estimación que dice "2 min" y tarda
  // 3 molesta menos que una que promete 1 min y no llega nunca.
  function remainingText(seconds) {
    if (seconds === null || seconds === undefined) return "";
    const s = Math.max(0, Math.ceil(seconds));
    if (s < 45) return t("menos de 1 min");
    const min = Math.ceil(s / 60);
    if (min < 60) return t("~{m} min", { m: min });
    const h = Math.floor(min / 60), m = min % 60;
    return t("~{h} h {m} min", { h, m: String(m).padStart(2, "0") });
  }

  // ---------------------------------------------------------------------------
  // Estimación de lo que falta
  // ---------------------------------------------------------------------------
  /* Se estima con lo YA medido: cuánto tardaron las partes terminadas de este
   * mismo trabajo. No hay tabla de velocidades ni promedio global — cada archivo
   * y cada conexión son distintos.
   *
   *   done:    partes terminadas
   *   total:   partes en total
   *   elapsed: segundos desde que arrancó la primera parte
   *
   * Con cero partes terminadas no se estima nada: mejor no decir nada que mentir. */
  function eta(done, total, elapsed) {
    if (!total || !done || done >= total || !(elapsed > 0)) return null;
    return (elapsed / done) * (total - done);
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida del trabajo
  // ---------------------------------------------------------------------------
  /* Arranca un trabajo largo.
   *   kind:  "file" | "meeting" (solo informativo, para el icono)
   *   title: de qué se trata (nombre del archivo, nombre de la reunión)
   *   steps: partes previstas, si se saben (se puede corregir después con phase()) */
  function start({ kind = "file", title = "", steps = 0 } = {}) {
    const ahora = cb.now();
    job = {
      kind,
      title,
      label: "",
      note: "",
      steps: steps || 0,
      done: 0,            // partes TERMINADAS (para estimar lo que falta)
      inner: null,        // avance dentro de la etapa actual (0..1), si se sabe
      startedAt: ahora,
      stepsStartedAt: 0,  // cuándo arrancó la primera parte (para el promedio)
      failed: false,
    };
    startTicking();
    render();
  }

  /* Cambia la etapa visible.
   *   label:  qué está haciendo ahora ("Transcribiendo parte 3 de 12…")
   *   opts.fraction: avance dentro de la etapa (0..1) o null si no se sabe
   *   opts.done / opts.steps: partes terminadas / totales (mueven la estimación)
   *   opts.note: "" borra el aviso suelto anterior (por defecto se conserva) */
  function phase(label, opts = {}) {
    if (!job) return;
    job.label = label || job.label;
    // Cambió la cantidad de partes: es otra escala (primero 12 trozos de audio,
    // después 3 llamadas de formateo). La estimación arranca de cero, porque lo
    // que tardó la etapa anterior no dice nada de la nueva.
    if (typeof opts.steps === "number" && opts.steps !== job.steps) {
      job.steps = opts.steps;
      job.stepsStartedAt = 0;
      job.done = 0;
    }
    if (typeof opts.done === "number") {
      // La primera parte marca el arranque del tramo que se promedia: lo de antes
      // (convertir con ffmpeg, por ejemplo) no dice nada sobre lo que tarda Groq.
      if (!job.stepsStartedAt) job.stepsStartedAt = cb.now();
      job.done = opts.done;
    }
    job.inner = typeof opts.fraction === "number" ? opts.fraction : null;
    if (typeof opts.note === "string") job.note = opts.note;
    render();
  }

  // Avance fino dentro de la etapa (la conversión de ffmpeg, que sí reporta %).
  function fraction(f) {
    if (!job) return;
    job.inner = typeof f === "number" ? Math.max(0, Math.min(1, f)) : null;
    render();
  }

  /* Aviso suelto que no cambia la etapa: el reintento de Groq, un warning. Se
   * muestra al lado del título y se borra con note(""). */
  function note(msg) {
    if (!job) return;
    job.note = msg || "";
    render();
  }

  /* Termina el trabajo: la barra se apaga y se avisa con qué mensaje final
   * ({active:false, final}). Quién dibuja decide qué hacer con él (la píldora lo
   * deja en la línea de estado). */
  function finish(msg = "") {
    if (!job) return;
    const failed = job.failed;
    stopTicking();
    job = null;
    if (cb.onRender) cb.onRender({ active: false, final: msg || "", failed });
    if (cb.onTray) cb.onTray("");
  }

  function fail(msg = "") {
    if (!job) return;
    job.failed = true;
    finish(msg);
  }

  function isActive() { return job !== null; }

  // ---------------------------------------------------------------------------
  // Lo que ve la UI
  // ---------------------------------------------------------------------------
  /* Una foto del estado, ya masticada para dibujar:
   *   percent: 0..100 o null (barra indeterminada: se sabe que trabaja, no cuánto falta)
   *   elapsedText / remainingText: textos listos para mostrar */
  function view() {
    if (!job) return { active: false };
    const elapsed = (cb.now() - job.startedAt) / 1000;
    const restante = job.stepsStartedAt
      ? eta(job.done, job.steps, (cb.now() - job.stepsStartedAt) / 1000)
      : null;
    return {
      active: true,
      kind: job.kind,
      title: job.title,
      label: job.label,
      note: job.note,
      done: job.done,
      steps: job.steps,
      percent: percent(),
      elapsed,
      elapsedText: clockText(elapsed),
      remaining: restante,
      remainingText: remainingText(restante),
    };
  }

  /* Porcentaje global. Con partes conocidas, cada parte vale 1/steps y el avance
   * dentro de la parte actual suma su fracción: así la barra se mueve también
   * DENTRO de una parte larga (la conversión de un video de una hora) y no salta
   * de golpe cada varios minutos. */
  function percent() {
    if (!job) return null;
    if (job.steps > 0) {
      const dentro = job.inner !== null ? Math.max(0, Math.min(1, job.inner)) : 0;
      const p = (job.done + dentro) / job.steps;
      return Math.round(Math.max(0, Math.min(1, p)) * 100);
    }
    if (job.inner !== null) return Math.round(job.inner * 100);
    return null; // indeterminada
  }

  /* Texto para el tooltip de la bandeja: con la píldora escondida es la única
   * forma de ver en qué anda sin volver a mostrarla. */
  function trayText() {
    if (!job) return "";
    const p = percent();
    const partes = [job.label || t("Trabajando…")];
    if (p !== null) partes.push(`${p} %`);
    partes.push(clockText((cb.now() - job.startedAt) / 1000));
    let linea = partes.join(" · ");
    if (job.title) linea += `\n${job.title}`;
    return linea;
  }

  // ---------------------------------------------------------------------------
  // Tick: el reloj corre aunque la etapa no cambie
  // ---------------------------------------------------------------------------
  function startTicking() {
    if (tickId || !cb.onRender) return;
    tickId = setInterval(render, 1000);
  }
  function stopTicking() {
    if (tickId) clearInterval(tickId);
    tickId = null;
  }
  function render() {
    if (cb.onRender) cb.onRender(view());
    if (cb.onTray) cb.onTray(trayText());
  }

  window.VLProgress = {
    configure, start, phase, fraction, note, finish, fail, isActive, view, trayText,
    // expuestos para tests
    _clockText: clockText,
    _remainingText: remainingText,
    _eta: eta,
  };
})();
