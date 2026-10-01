const test = require('node:test');
const assert = require('node:assert');
const preview = require('../../src/modules/chat/link-preview');

// Link previews: what's read from a page, and the guards on what Liston's
// server will fetch (public sites only, never eBay, AliExpress or Liston).

test("a page's preview from its Open Graph tags, else its title and description", () => {
  const og = `<html><head><title>Ignored</title>
    <meta property="og:title" content="Packing &amp; posting guide">
    <meta content='How to pack fragile items' property='og:description'>
    <meta property="og:image" content="/img/cover.jpg"><meta property="og:site_name" content="Royal Mail"></head></html>`;
  assert.deepStrictEqual(preview.parsePreview(og, 'https://www.royalmail.com/guide'), {
    url: 'https://www.royalmail.com/guide',
    title: 'Packing & posting guide',
    description: 'How to pack fragile items',
    image: 'https://www.royalmail.com/img/cover.jpg',
    site: 'Royal Mail',
  });
  const plain = preview.parsePreview('<title> Tracking help </title><meta name="description" content="Find your parcel">', 'https://www.example.co.uk/t');
  assert.deepStrictEqual([plain.title, plain.description, plain.image, plain.site], ['Tracking help', 'Find your parcel', null, 'example.co.uk']);
  assert.strictEqual(preview.parsePreview('<p>nothing here</p>', 'https://example.com'), null);
  assert.strictEqual(preview.parsePreview('<meta property="og:title" content="x"><meta property="og:image" content="javascript:alert(1)">', 'https://example.com').image, null);
});

test('only public sites are fetched: no private, loopback or link-local address, no other ports, no logins, never eBay, AliExpress or Liston', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.strictEqual(preview.privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:85e5']) assert.strictEqual(preview.privateAddress(ip), false, ip);
  assert.strictEqual(preview.fetchable('https://example.com:8443/x'), null);
  assert.strictEqual(preview.fetchable('https://user:pw@example.com/'), null);
  assert.strictEqual(preview.fetchable('ftp://example.com/'), null);
  assert.strictEqual(preview.fetchable('http://169.254.169.254/latest/meta-data'), null);
  assert.strictEqual(preview.fetchable('https://www.ebay.co.uk/itm/1'), null);
  assert.strictEqual(preview.fetchable('https://liston.app/x', { skipHosts: ['liston.app'] }), null);
  assert.ok(preview.fetchable('https://example.com/a'));
  // A name that resolves to a private address is refused at the connection itself.
  const err = await new Promise((resolve) => preview.safeLookup('localhost', {}, (e) => resolve(e)));
  assert.strictEqual(err?.code, 'EPRIVATE');
  await assert.rejects(preview.fetchPage('http://127.0.0.1/'), /Not a link Liston fetches/);
  assert.deepStrictEqual(preview.linksIn('a https://a.com/1 b https://a.com/1 https://b.com/2, https://c.com/3. https://d.com/4'), ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']);
});

test('previews for a message: each link read once, a page that fails left out', async () => {
  const pages = { 'https://good.com/': '<meta property="og:title" content="Good">', 'https://bad.com/': null };
  const out = await preview.previewsFor('see https://good.com/ and https://bad.com/', {
    fetch: async (url) => {
      if (!pages[url]) throw new Error('down');
      return { url, html: pages[url] };
    },
  });
  assert.deepStrictEqual(out.map((p) => [p.url, p.title]), [['https://good.com/', 'Good']]);
});
