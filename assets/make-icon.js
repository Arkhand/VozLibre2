/* VozLibre2 — Generador de icono
 * ================================
 * Dibuja el icono de la app (orbe glass índigo→violeta sobre cápsula oscura) a
 * varios tamaños y los empaqueta en un .ico de Windows.
 *
 * No usa librerías de dibujo: rasteriza a mano sobre un buffer RGBA con
 * antialiasing por supersampling (SSAA x3), codifica cada tamaño a PNG con Jimp
 * y los envuelve en el contenedor ICO (que admite PNG embebido).
 *
 *   node assets/make-icon.js     (o: npm run icon)
 *
 * Paleta (de src/renderer/style.css):
 *   índigo  #6366f1   violeta #a855f7
 *   glass   #16182a   glass-2 #22253f   (fondo cápsula)
 */
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");

const SS = 3; // supersampling para bordes suaves

// --- utilidades de color -------------------------------------------------
function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

const INDIGO = hex("#6366f1");
const VIOLET = hex("#a855f7");
const GLASS = hex("#16182a");
const GLASS2 = hex("#2a2e52"); // un poco más vivo que glass-2 para que se note
const WHITE = [255, 255, 255];

// Dibuja el icono en un canvas de lado `S` (en alta resolución, S = size*SS).
function render(S) {
  const buf = Buffer.alloc(S * S * 4, 0); // RGBA, transparente
  const set = (x, y, r, g, b, a) => {
    const i = (y * S + x) * 4;
    buf[i] = Math.round(r); buf[i + 1] = Math.round(g);
    buf[i + 2] = Math.round(b); buf[i + 3] = Math.round(a);
  };

  const cx = S / 2, cy = S / 2;
  const radiusCapsule = S * 0.5;       // la cápsula casi llena el lienzo
  const corner = S * 0.30;             // radio de esquina (squircle redondeado)
  const half = radiusCapsule;          // medio-lado de la cápsula
  const orbR = S * 0.30;               // radio del orbe central
  const aa = 1.5;                      // ancho del borde antialias (px @ hi-res)

  // luz del orbe (degradado diagonal 135°, como el CSS): de arriba-izq a abajo-der
  const lightDir = [-0.55, -0.55];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;

      // --- máscara de la cápsula redondeada (rounded square / squircle) ---
      // distancia a un rect redondeado centrado
      const qx = Math.abs(px) - (half - corner);
      const qy = Math.abs(py) - (half - corner);
      const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
      const outside = Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - corner;
      const capMask = 1 - smoothstep(0, aa, outside); // 1 dentro, 0 fuera
      if (capMask <= 0) continue;

      // --- fondo glass: degradado vertical glass-2 (arriba) -> glass (abajo) ---
      const gt = clamp01((py + half) / (2 * half));
      let [r, g, b] = mix(GLASS2, GLASS, gt);

      // brillo superior interno (borde luminoso arriba)
      const topGlow = smoothstep(half * 0.55, half, -py) * 0.10;
      r = mix([r, g, b], WHITE, topGlow)[0];
      [r, g, b] = mix([r, g, b], WHITE, topGlow);

      // halo índigo difuso arriba-izquierda (como .pill::before)
      const haloD = Math.hypot(px + half * 0.35, py + half * 0.35);
      const halo = smoothstep(half * 1.1, 0, haloD) * 0.18;
      [r, g, b] = mix([r, g, b], INDIGO, halo);

      let a = 255 * capMask;

      // --- orbe central (degradado índigo->violeta + highlight especular) ---
      const od = Math.hypot(px, py);
      const orbMask = 1 - smoothstep(orbR - aa, orbR + aa, od);
      if (orbMask > 0) {
        // posición proyectada sobre la dirección de luz -> t del degradado
        const proj = (px * lightDir[0] + py * lightDir[1]) / (orbR * 1.1);
        const t = clamp01(0.5 + proj * 0.5);
        let [or_, og, ob] = mix(VIOLET, INDIGO, t); // luz=índigo, sombra=violeta

        // sombreado esférico (oscurece hacia el borde inferior-derecho)
        const shade = 1 - smoothstep(0, orbR, od) * 0.25;
        or_ *= shade; og *= shade; ob *= shade;

        // highlight especular (mancha brillante arriba-izquierda)
        const hlD = Math.hypot(px + orbR * 0.34, py + orbR * 0.34);
        const hl = smoothstep(orbR * 0.5, 0, hlD) * 0.55;
        [or_, og, ob] = mix([or_, og, ob], WHITE, hl);

        // anillo glow sutil alrededor del orbe
        [r, g, b] = mix([r, g, b], or_ === or_ ? [or_, og, ob] : [r, g, b], orbMask);

        // --- punto/onda blanca central (el "orb-dot") ---
        const dotR = orbR * 0.30;
        const dotMask = 1 - smoothstep(dotR - aa, dotR + aa, od);
        if (dotMask > 0) {
          const wr = mix([r, g, b], WHITE, dotMask);
          r = wr[0]; g = wr[1]; b = wr[2];
        }
      }

      // borde luminoso fino del orbe (anillo)
      const ring = (1 - smoothstep(orbR - aa * 1.2, orbR, od)) * smoothstep(orbR - aa * 2.5, orbR - aa * 1.2, od);
      if (ring > 0) [r, g, b] = mix([r, g, b], WHITE, ring * 0.25);

      set(x, y, r, g, b, a);
    }
  }
  return buf;
}

// Reduce el buffer hi-res a `size` por promedio de bloques SSxSS (downsample AA).
function downsample(hiBuf, S, size) {
  const out = Buffer.alloc(size * size * 4, 0);
  const block = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < block; sy++) {
        for (let sx = 0; sx < block; sx++) {
          const px = Math.floor(x * block + sx);
          const py = Math.floor(y * block + sy);
          const i = (py * S + px) * 4;
          const al = hiBuf[i + 3];
          r += hiBuf[i] * al; g += hiBuf[i + 1] * al; b += hiBuf[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a / n;
    }
  }
  return out;
}

async function bufToPng(rgba, size) {
  const img = new Jimp({ data: Buffer.from(rgba), width: size, height: size });
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

// Empaqueta varios PNG en un .ico (cada entrada = un PNG completo embebido).
function buildIco(pngs) {
  // pngs: [{size, data}]
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type 1 = icon
  header.writeUInt16LE(count, 4); // image count

  const dirEntries = [];
  const dataBlobs = [];
  let offset = 6 + count * 16;

  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2);   // palette
    e.writeUInt8(0, 3);   // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8); // size of data
    e.writeUInt32LE(offset, 12);     // offset
    offset += data.length;
    dirEntries.push(e);
    dataBlobs.push(data);
  }
  return Buffer.concat([header, ...dirEntries, ...dataBlobs]);
}

(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  // Renderiza el tamaño más grande en hi-res una vez por tamaño objetivo para
  // que cada uno tenga el mejor detalle posible.
  for (const size of sizes) {
    const S = size * SS;
    const hi = render(S);
    const small = downsample(hi, S, size);
    const png = await bufToPng(small, size);
    pngs.push({ size, data: png });
    // guardar el 256 también como PNG suelto (útil para Linux/preview)
    if (size === 256) fs.writeFileSync(path.join(__dirname, "icon.png"), png);
  }
  const ico = buildIco(pngs);
  fs.writeFileSync(path.join(__dirname, "icon.ico"), ico);
  console.log(`icon.ico (${ico.length} bytes, ${sizes.length} tamaños) + icon.png generados en assets/`);
})();
