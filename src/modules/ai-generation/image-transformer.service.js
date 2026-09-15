const config = require('../../config');
const logger = require('../../utils/logger');

// Extracts a result image URL from a Bria response — the shape genuinely
// differs per endpoint, confirmed with real API calls this session:
// remove_background returns { result: { image_url } }, while
// lifestyle_shot_by_text returns { result: [[url, sizeBytes, filename]] }
// (an array of arrays). Handles both rather than assuming one shape.
function extractResultUrl(data) {
  if (Array.isArray(data.result) && typeof data.result[0]?.[0] === 'string') {
    return data.result[0][0];
  }
  return data.result_url || data.result?.image_url || data.result?.url || data.image_url || data.url || null;
}

// Bria's "Lifestyle Product Shot by Text" API — cuts the product out and
// generates a new studio/lifestyle background from a text prompt, per
// ARCHITECTURE.md §15 ("cutout + AI-generated background/scene from text or
// reference image"). This is the actual quality improvement over plain
// background removal — a mediocre supplier photo with just the background
// stripped is still a mediocre photo. Endpoint/params confirmed live against
// platform.bria.ai's own sandbox this session (they differ from what an
// earlier version of this file guessed).
async function transformWithBriaComposite(imageUrl, scenePrompt) {
  const res = await fetch('https://engine.prod.bria-api.com/v1/product/lifestyle_shot_by_text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_token: config.briaApiKey },
    body: JSON.stringify({
      image_url: imageUrl,
      scene_description: scenePrompt,
      mode: 'high_control',
      placement_type: 'original',
      num_results: 1,
      optimize_description: true,
      sync: true,
    }),
  });
  if (!res.ok) throw new Error(`Bria composite request failed (${res.status})`);
  const data = await res.json();
  const resultUrl = extractResultUrl(data);
  if (!resultUrl) throw new Error('Bria composite response had no recognizable result URL');
  return resultUrl;
}

// Bria's plain background-removal API — a lesser fallback if compositing
// fails but the API key itself is valid: still better than nothing, just no
// generated scene behind the cutout. Endpoint/param confirmed live this
// session (it's `/v2/image/edit/remove_background` with an `image` field,
// not the `/v1/background/remove` + `image_url` this file originally guessed).
async function transformWithBria(imageUrl) {
  const res = await fetch('https://engine.prod.bria-api.com/v2/image/edit/remove_background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_token: config.briaApiKey },
    body: JSON.stringify({ image: imageUrl, sync: true }),
  });
  if (!res.ok) throw new Error(`Bria request failed (${res.status})`);
  const data = await res.json();
  const resultUrl = extractResultUrl(data);
  if (!resultUrl) throw new Error('Bria response had no recognizable result URL');
  return resultUrl;
}

// Photoroom's Remove Background API — fallback provider. Same caveat as
// above: implemented per public docs, not live-verified (no key available).
async function transformWithPhotoroom(imageUrl) {
  const res = await fetch(`https://sdk.photoroom.com/v1/segment?image_url=${encodeURIComponent(imageUrl)}&format=json`, {
    method: 'GET',
    headers: { 'x-api-key': config.photoroomApiKey },
  });
  if (!res.ok) throw new Error(`Photoroom request failed (${res.status})`);
  const data = await res.json();
  if (!data.result_b64) throw new Error('Photoroom response missing result_b64');
  return `data:image/png;base64,${data.result_b64}`;
}

let warnedNoKeys = false;

// Four-tier fallback, never hard-fails a draft over image processing:
// Bria scene composite -> Bria background removal -> Photoroom -> raw URL.
async function transformImage(imageUrl, scenePrompt) {
  if (config.briaApiKey) {
    try {
      return await transformWithBriaComposite(imageUrl, scenePrompt);
    } catch (err) {
      logger.warn('Bria scene composite failed, falling back to plain background removal', { error: err.message });
    }
    try {
      return await transformWithBria(imageUrl);
    } catch (err) {
      logger.warn('Bria background removal failed, falling back', { error: err.message });
    }
  }
  if (config.photoroomApiKey) {
    try {
      return await transformWithPhotoroom(imageUrl);
    } catch (err) {
      logger.warn('Photoroom image transform failed, falling back to raw image', { error: err.message });
    }
  }
  if (!config.briaApiKey && !config.photoroomApiKey && !warnedNoKeys) {
    logger.warn('BRIA_API_KEY/PHOTOROOM_API_KEY not set — using unprocessed source images');
    warnedNoKeys = true;
  }
  return imageUrl;
}

async function transformImages(imageUrls, scenePrompt) {
  return Promise.all(imageUrls.map((url) => transformImage(url, scenePrompt)));
}

// Background removal only — no generated scene. Used for per-variant photos,
// where every variant must get the IDENTICAL treatment so the colours stay
// comparable; a scene generated separately per variant makes five colours of
// one product look like five different products. Falls back the same way
// transformImage does, ending at the untouched original.
async function removeBackground(imageUrl) {
  if (config.briaApiKey) {
    try {
      return await transformWithBria(imageUrl);
    } catch (err) {
      logger.warn('Bria background removal failed, falling back', { error: err.message });
    }
  }
  if (config.photoroomApiKey) {
    try {
      return await transformWithPhotoroom(imageUrl);
    } catch (err) {
      logger.warn('Photoroom background removal failed, falling back to the raw image', { error: err.message });
    }
  }
  return imageUrl;
}

module.exports = { transformImages, removeBackground };
