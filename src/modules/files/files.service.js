const crypto = require('crypto');
const path = require('path');
const sharp = require('sharp');
const config = require('../../config');
const storage = require('../../lib/storage');
const filesRepository = require('./files.repository');
const logger = require('../../utils/logger');

// Files people share in the Inbox. An upload is checked (size, no
// programs), an image straightened, stripped of its camera data (where it
// was taken, the device) and given a small preview, then kept in storage.
// Nobody reads a file by its storage key: a private file is reached by a
// signed link that runs out (issued only after the caller checked who may
// see it), an eBay attachment by an unguessable public link that eBay can
// fetch, gone after 30 days.

const MAX_BYTES = 25 * 1024 * 1024;
const EBAY_DAYS = 30;
// Pictures a browser shows safely (never SVG: it can carry script).
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Shown in the browser rather than downloaded.
const INLINE = new Set([...IMAGES, 'application/pdf']);
// Programs and scripts: refused.
const BLOCKED = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'apk', 'app', 'dmg', 'pkg', 'sh', 'bash', 'zsh', 'reg', 'lnk', 'hta', 'cpl', 'dll', 'sys', 'iso']);
// sharp's format names to the file's type.
const FORMAT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

class FileError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
  }
}

const signingKey = () => crypto.createHmac('sha256', config.jwt.secret).update('liston-media-links').digest();
const sign = (id, variant, exp) => crypto.createHmac('sha256', signingKey()).update(`${id}:${variant}:${exp}`).digest('base64url').slice(0, 32);

/** A file name safe to keep and show: no folders, no control characters, at most 180 characters. */
function cleanName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..') return 'file';
  if (base.length <= 180) return base;
  const ext = path.extname(base).slice(0, 12);
  return base.slice(0, 180 - ext.length) + ext;
}

const extOf = (name) => path.extname(name).slice(1).toLowerCase();

/**
 * Keeps an uploaded file: { id, name, mime, size, width, height, image,
 * url, thumbUrl }. `purpose`: 'chat' (private to the team) or 'ebay' (sent
 * to a buyer, public for 30 days).
 */
async function upload(auth, { buffer, name, mime, purpose = 'chat' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new FileError('The file is empty.');
  if (buffer.length > MAX_BYTES) throw new FileError('Files can be up to 25 MB.', 413);
  if (!['chat', 'ebay'].includes(purpose)) throw new FileError('Unknown file purpose.');
  let fileName = cleanName(name);
  if (BLOCKED.has(extOf(fileName))) throw new FileError("Liston doesn't take programs or scripts. Zip it, or share a link instead.");

  let type = String(mime || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  let body = buffer;
  let thumb = null;
  let width = null;
  let height = null;
  // An image by its bytes, whatever the browser said: straightened, camera data left behind, a preview made.
  const meta = await sharp(buffer, { animated: true }).metadata().catch(() => null);
  if (meta && FORMAT_MIME[meta.format]) {
    type = FORMAT_MIME[meta.format];
    const turned = (meta.orientation || 1) >= 5;
    width = turned ? meta.height : meta.width;
    height = turned ? meta.width : (meta.pageHeight || meta.height);
    if (meta.format !== 'gif') {
      const image = sharp(buffer).rotate();
      body = await (meta.format === 'jpeg' ? image.jpeg({ quality: 92, mozjpeg: true }) : meta.format === 'png' ? image.png() : image.webp({ quality: 90 })).toBuffer();
    }
    thumb = await sharp(buffer, { animated: false })
      .rotate()
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
      .catch(() => null);
    const wanted = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'] }[type];
    if (!wanted.includes(extOf(fileName))) fileName = `${fileName.replace(/\.[^.]*$/, '')}.${wanted[0]}`;
  } else if (IMAGES.has(type) || type === 'image/svg+xml') {
    // Says it's a picture but isn't one Liston can show: kept as a plain file.
    type = 'application/octet-stream';
  }

  const id = crypto.randomUUID();
  const storageKey = `files/${auth.ownerId}/${id}`;
  const thumbKey = thumb ? `${storageKey}.thumb.webp` : null;
  await storage.put(storageKey, body, type);
  if (thumb) await storage.put(thumbKey, thumb, 'image/webp');
  const ebay = purpose === 'ebay';
  const row = await filesRepository.insert({
    id,
    ownerId: auth.ownerId,
    uploadedBy: auth.userId,
    purpose,
    storageKey,
    thumbKey,
    name: fileName,
    mime: type,
    size: body.length,
    width,
    height,
    publicToken: ebay ? crypto.randomBytes(24).toString('base64url') : null,
    expiresAt: ebay ? new Date(Date.now() + EBAY_DAYS * 86400000) : null,
  });
  return shape(row);
}

/**
 * A signed link to a private file, good for about `seconds` (rounded up to
 * the hour, so the same file keeps the same link for a while and the
 * browser can cache it). `variant`: 'full' or 'thumb'.
 */
function signedUrl(file, variant = 'full', seconds = 3600) {
  const exp = Math.ceil((Date.now() / 1000 + seconds) / 3600) * 3600;
  return `${config.apiUrl}/media/f/${file.id}/${variant}?exp=${exp}&sig=${sign(file.id, variant, exp)}`;
}

function verify(id, variant, exp, sig) {
  const n = Number(exp);
  if (!Number.isFinite(n) || n * 1000 < Date.now() || typeof sig !== 'string') return false;
  const want = Buffer.from(sign(id, variant, n));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The public link eBay reads an attachment from. */
function publicUrl(file) {
  return file.public_token ? `${config.apiUrl}/media/p/${file.public_token}/${encodeURIComponent(file.name)}` : null;
}

/** A file as the pages see it, with its links. */
function shape(file) {
  const image = IMAGES.has(file.mime);
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size_bytes,
    width: file.width,
    height: file.height,
    image,
    url: file.purpose === 'ebay' ? publicUrl(file) : signedUrl(file, 'full'),
    thumbUrl: file.thumb_key ? signedUrl(file, 'thumb') : null,
    createdAt: file.created_at,
  };
}

/** One file for whoever uploaded it (or the owner): before it's sent anywhere. */
async function get(auth, id) {
  const file = await filesRepository.findById(id);
  if (!file || file.owner_user_id !== auth.ownerId || (file.uploaded_by !== auth.userId && auth.role !== 'owner')) throw new FileError('File not found.', 404);
  return shape(file);
}

/** Sends a file's bytes (or the browser to R2): the /media routes. */
async function send(res, file, variant, { range = null } = {}) {
  const key = variant === 'thumb' ? file.thumb_key : file.storage_key;
  if (!key) return res.status(404).json({ error: 'Not found' });
  const mime = variant === 'thumb' ? 'image/webp' : file.mime;
  const inline = INLINE.has(mime) || /^audio\//.test(mime);
  // The frontend is another origin: it may show these; nothing in them may run.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', file.purpose === 'ebay' ? 'public, max-age=86400' : 'private, max-age=3600');
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  // An eBay attachment's bytes come from here, never a redirect: eBay fetches the link itself, and a stored link that runs out would break.
  const direct = file.purpose === 'ebay' ? null : await storage.directUrl(key, { seconds: 600, filename: inline ? file.name : null, contentType: mime }).catch(() => null);
  if (direct) return res.redirect(302, direct);
  res.setHeader('Accept-Ranges', 'bytes');
  // Part of it (a voice note seeking, Safari starting one): local files answer ranges here.
  const wanted = /^bytes=(\d*)-(\d*)$/.exec(String(range || ''));
  if (wanted && (wanted[1] || wanted[2])) {
    const part = wanted[1] ? await storage.readRange(key, Number(wanted[1]), wanted[2] ? Number(wanted[2]) : null) : null;
    if (part) {
      if (!part.stream) {
        res.setHeader('Content-Range', `bytes */${part.size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Content-Range', `bytes ${part.start}-${part.end}/${part.size}`);
      res.setHeader('Content-Length', String(part.end - part.start + 1));
      part.stream.on('error', () => res.destroy());
      return part.stream.pipe(res);
    }
  }
  const found = await storage.read(key);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', disposition);
  if (found.size !== null) res.setHeader('Content-Length', String(found.size));
  found.stream.on('error', (err) => {
    logger.warn('Media: file not read', { fileId: file.id, error: err.message });
    res.destroy();
  });
  found.stream.pipe(res);
}

/** A file's bytes (a Buffer), or null when they're gone. */
async function bytesOf(file) {
  return storage.readBuffer(file.storage_key);
}

/** Deletes eBay attachments past their 30 days, and their bytes. */
async function removeExpired() {
  const expired = await filesRepository.findExpired();
  for (const file of expired) {
    await storage.remove(file.storage_key).catch(() => {});
    if (file.thumb_key) await storage.remove(file.thumb_key).catch(() => {});
    await filesRepository.remove(file.id);
  }
  return expired.length;
}

module.exports = { upload, get, shape, signedUrl, verify, publicUrl, send, bytesOf, removeExpired, cleanName, FileError, MAX_BYTES, IMAGES };
