const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

// Where shared files live (the Inbox's team chat files and the attachments
// sent to eBay buyers): Cloudflare R2 through its S3 API when R2 is set up,
// else a folder on this machine. Keys are opaque paths ("files/<owner>/<id>")
// chosen by the caller; nothing outside this file knows which store is used.
// Reads go through Liston's own /media routes (files/media.js), so the
// bucket stays private and a link can be checked and expired.

let client = null; // the S3 client, made on first use

function r2Configured() {
  const r2 = config.storage.r2;
  return Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket);
}

function driver() {
  return r2Configured() ? 'r2' : 'local';
}

function s3() {
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const r2 = config.storage.r2;
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
  }
  return client;
}

// A key never climbs out of the storage folder.
function localPath(key) {
  const clean = String(key).replace(/\\/g, '/');
  if (!clean || clean.split('/').some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error('Bad storage key');
  }
  return path.join(config.storage.dir, clean);
}

/** Keeps `body` (a Buffer) under `key`. */
async function put(key, body, contentType = 'application/octet-stream') {
  if (driver() === 'r2') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new PutObjectCommand({ Bucket: config.storage.r2.bucket, Key: key, Body: body, ContentType: contentType }));
    return;
  }
  const file = localPath(key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
}

/**
 * The file as a readable stream, or null when there's no such key:
 * { stream, size }.
 */
async function read(key) {
  if (driver() === 'r2') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const res = await s3().send(new GetObjectCommand({ Bucket: config.storage.r2.bucket, Key: key }));
      return { stream: res.Body, size: res.ContentLength ?? null };
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
  const file = localPath(key);
  try {
    const stat = await fsp.stat(file);
    return { stream: fs.createReadStream(file), size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether a key's bytes are there (a stored link can outlive them: a local folder lost on a redeploy). */
async function exists(key) {
  if (driver() === 'r2') {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await s3().send(new HeadObjectCommand({ Bucket: config.storage.r2.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }
  try {
    await fsp.access(localPath(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where files are kept, for the start of the server's log: { lasting, where }.
 * A local folder lasts only on a mounted volume; on a host like Railway
 * without one, a redeploy starts with it empty.
 */
function describe() {
  if (driver() === 'r2') return { lasting: true, where: `Cloudflare R2 (bucket ${config.storage.r2.bucket})` };
  const dir = path.resolve(config.storage.dir);
  const onVolume = Boolean(config.storage.volume) && (dir + path.sep).startsWith(path.resolve(config.storage.volume) + path.sep);
  return { lasting: onVolume, where: onVolume ? `the mounted volume (${dir})` : `this server's own disk (${dir})` };
}

/** The whole file as a Buffer, or null. */
/**
 * Part of a stored file, for a browser asking for a range (audio and video
 * seek, and Safari plays nothing without it): { stream, start, end, size }
 * or null. Local files only: R2 answers ranges on its own links.
 */
async function readRange(key, start, end) {
  if (driver() === 'r2') return null;
  const file = localPath(key);
  try {
    const { size } = await fsp.stat(file);
    if (start >= size) return { stream: null, start, end: size - 1, size };
    const last = Math.min(end ?? size - 1, size - 1);
    return { stream: fs.createReadStream(file, { start, end: last }), start, end: last, size };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readBuffer(key) {
  const found = await read(key);
  if (!found) return null;
  const chunks = [];
  for await (const chunk of found.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Forgets `key` (nothing happens when it isn't there). */
async function remove(key) {
  if (driver() === 'r2') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new DeleteObjectCommand({ Bucket: config.storage.r2.bucket, Key: key }));
    return;
  }
  await fsp.rm(localPath(key), { force: true });
}

/**
 * A link straight to the file in R2, good for `seconds` (the /media routes
 * send the browser there rather than carry the bytes); null on the local
 * store, where /media streams the file itself.
 */
async function directUrl(key, { seconds = 300, filename = null, contentType = null } = {}) {
  if (driver() !== 'r2') return null;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const command = new GetObjectCommand({
    Bucket: config.storage.r2.bucket,
    Key: key,
    ResponseContentType: contentType || undefined,
    ResponseContentDisposition: filename ? `inline; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
  });
  return getSignedUrl(s3(), command, { expiresIn: seconds });
}

/** Test hook: a stand-in S3 client. */
function useClient(fake) {
  client = fake;
}

module.exports = { put, read, readRange, readBuffer, remove, exists, describe, directUrl, driver, r2Configured, useClient, localPath };
