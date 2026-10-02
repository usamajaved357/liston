const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

// Link previews for team chat (ARCHITECTURE §9.1, decision 4): a link to
// another site in a message gets its title, description, picture and site
// name, read once when the message is sent. It's Liston's server asking a
// site its people chose, so with guards: http(s) only on ports 80 and 443,
// no logins in the link, public addresses only (checked on the address the
// connection really uses, so a name that resolves, or re-resolves, to a
// private one is refused), at most three redirects (each checked again),
// five seconds, the first 512 KB, and only HTML. eBay and AliExpress links
// are never fetched (they become cards through their own APIs, never
// scraped), nor Liston's own pages.

const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_LINKS = 3;
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const SKIP_HOSTS = /(^|\.)(ebay\.[a-z.]{2,8}|ebayimg\.com|ebaystatic\.com|aliexpress\.[a-z.]{2,8}|alicdn\.com|localhost)$/i;

/** Whether an address is one of the network's own (loopback, private, link-local, carrier, multicast…): never fetched. */
function privateAddress(ip) {
  const v = String(ip || '').toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!net.isIPv6(v)) return true;
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return privateAddress(mapped[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(v);
}

// dns.lookup that refuses a private address, on the very address the socket will connect to.
function safeLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) {
      return callback(Object.assign(new Error('That address is not on the public internet.'), { code: 'EPRIVATE' }));
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** A link Liston may fetch: http(s), a usual port, no login, not eBay, AliExpress, Liston or a bare address on this machine. */
function fetchable(raw, { skipHosts = [] } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const host = u.hostname.toLowerCase();
  if (SKIP_HOSTS.test(host) || skipHosts.includes(host)) return null;
  if ((net.isIP(host.replace(/^\[|\]$/g, '')) && privateAddress(host.replace(/^\[|\]$/g, ''))) || !host.includes('.')) return null;
  return u;
}

/** The links in a message worth a preview, in order, each once, at most three. */
function linksIn(text, { skipHosts = [] } = {}) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = fetchable(m[0], { skipHosts });
    if (!u) continue;
    const href = u.toString();
    if (!out.includes(href)) out.push(href);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** One GET with the guards: { url (after redirects), html } or a thrown error. */
function fetchPage(url, { redirects = 0, lookup = safeLookup } = {}) {
  return new Promise((resolve, reject) => {
    const u = fetchable(url);
    if (!u) return reject(new Error('Not a link Liston fetches.'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      u,
      {
        lookup,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Liston link preview)', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'en-GB,en;q=0.8' },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects.'));
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return reject(new Error('A broken redirect.'));
          }
          return fetchPage(next, { redirects: redirects + 1, lookup }).then(resolve, reject);
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`The site answered ${status}.`));
        }
        if (!/text\/html|application\/xhtml/i.test(String(res.headers['content-type'] || ''))) {
          res.resume();
          return reject(new Error('Not a web page.'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BYTES) res.destroy();
        });
        const done = () => resolve({ url: u.toString(), html: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8') });
        res.on('end', done);
        res.on('close', done);
        res.on('error', reject);
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('The site took too long.')));
    req.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || null);

/**
 * A page's preview from its HTML (pure): { url, title, description, image,
 * site } from its Open Graph and Twitter tags, else its <title> and
 * description; null when it has neither a title nor a description.
 */
function parsePreview(html, url) {
  const head = String(html || '').slice(0, MAX_BYTES);
  const meta = {};
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && meta[key] === undefined) meta[key] = decode(attrs.content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = meta['og:title'] || meta['twitter:title'] || (titleTag ? decode(titleTag[1]) : '');
  const description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  if (!title && !description) return null;
  let image = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || null;
  try {
    image = image ? new URL(image, url).toString() : null;
    if (image && !/^https?:/i.test(image)) image = null;
  } catch {
    image = null;
  }
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  return { url, title: clip(title, 200), description: clip(description, 300), image, site: clip(meta['og:site_name'] || host, 80) };
}

/** Previews for a message's links, in order (any that can't be read left out). */
async function previewsFor(text, { skipHosts = [], fetch = fetchPage } = {}) {
  const links = linksIn(text, { skipHosts });
  const found = await Promise.all(
    links.map(async (link) => {
      try {
        const page = await fetch(link);
        const preview = parsePreview(page.html, page.url);
        return preview ? { ...preview, url: link } : null;
      } catch {
        return null;
      }
    })
  );
  return found.filter(Boolean);
}

module.exports = { privateAddress, safeLookup, fetchable, linksIn, fetchPage, parsePreview, previewsFor, MAX_LINKS };
