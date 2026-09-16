const sharp = require('sharp');
const config = require('../../../config');

// The elements the seller wants on the MAIN image only — a UK flag, a FREE
// SHIPPING label, an optional thin border — drawn as vector overlays rather
// than asked of a model. Deterministic, legible, identical on every listing,
// and free. Every other image in the gallery stays plain photography.
//
// eBay's picture policy discourages badges and borders on listing images; the
// seller has chosen them knowingly, and the draft carries a warning saying so.

function flagSvg(size) {
  // A Union Flag drawn to spec proportions (1:2), scaled to `size` high.
  const h = size;
  const w = size * 2;
  const sw = h / 5; // diagonal white
  const sr = h / 15; // diagonal red
  return `
    <svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 60 30" xmlns="http://www.w3.org/2000/svg">
      <clipPath id="c"><rect width="60" height="30"/></clipPath>
      <g clip-path="url(#c)">
        <rect width="60" height="30" fill="#012169"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="${(sw / h) * 30}"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="${(sr / h) * 30}"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#fff" stroke-width="10"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>
      </g>
    </svg>`;
}

async function brandHero(buffer, settings = config.imageGeneration) {
  const { width, height } = await sharp(buffer).metadata();
  const W = width || 1600;
  const H = height || 1600;
  const pad = Math.round(W * 0.03);
  const layers = [];

  if (settings.addGlowBorder) {
    const bw = Math.max(4, Math.round(W * 0.006));
    layers.push(
      `<rect x="${bw / 2}" y="${bw / 2}" width="${W - bw}" height="${H - bw}" rx="${W * 0.02}" fill="none" stroke="#1E1E2E" stroke-opacity="0.85" stroke-width="${bw}"/>`
    );
  }

  if (settings.addUkFlag) {
    const fh = Math.round(H * 0.075);
    const fw = fh * 2;
    layers.push(
      `<g transform="translate(${pad},${H - pad - fh})">
         <rect x="-3" y="-3" width="${fw + 6}" height="${fh + 6}" rx="6" fill="#fff" stroke="#e5e5e5"/>
         ${flagSvg(fh)}
       </g>`
    );
  }

  if (settings.addFreeShippingLabel) {
    const lh = Math.round(H * 0.075);
    const lw = Math.round(lh * 3.6);
    const fs = Math.round(lh * 0.42);
    layers.push(
      `<g transform="translate(${W - pad - lw},${H - pad - lh})">
         <rect width="${lw}" height="${lh}" rx="${lh / 2}" fill="#1E1E2E"/>
         <text x="${lw / 2}" y="${lh / 2}" dy="0.36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${fs}" letter-spacing="1" fill="#fff">FREE SHIPPING</text>
       </g>`
    );
  }

  if (!layers.length) return buffer;

  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${layers.join('')}</svg>`);
  return sharp(buffer).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

function activeBadges(settings = config.imageGeneration) {
  return [
    settings.addUkFlag ? 'UK flag' : null,
    settings.addFreeShippingLabel ? 'FREE SHIPPING label' : null,
    settings.addGlowBorder ? 'border' : null,
  ].filter(Boolean);
}

module.exports = { brandHero, activeBadges };
