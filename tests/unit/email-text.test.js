const test = require('node:test');
const assert = require('node:assert');

const email = require('../../src/utils/email');

// Every email goes with a plain-text copy of its HTML (utils/email toText):
// the words in reading order, each button as its label and link, without the
// hidden preview line, the logo or any markup.

const link = 'https://app.example.com/invite/abc.def';
const html = email.layout({
  preheader: 'Join Talha Traders on Liston.',
  title: 'Join Talha Traders',
  intro: '<strong style="color:#0f172a">Talha</strong> invited you to work in <strong>Talha &amp; Sons</strong> on Liston.',
  action: email.button('Accept the invitation', link),
  afterAction: `<p>If the button doesn't work, copy this link into your browser:<br><a href="${link}">${link}</a></p>`,
  footnote: 'This invitation works for 7 days.',
});

test('the text copy reads as the email does, its button a label and link', () => {
  const text = email.toText(html);
  assert.ok(text.startsWith('Liston\n\nJoin Talha Traders'), text);
  assert.match(text, /Talha invited you to work in Talha & Sons on Liston\./);
  assert.match(text, new RegExp(`Accept the invitation: ${link.replace(/\./g, '\\.')}`));
  assert.match(text, /This invitation works for 7 days\./);
  assert.doesNotMatch(text, /<|>|&amp;|style=/, 'no markup left');
  assert.doesNotMatch(text, /Join Talha Traders on Liston\./, 'the hidden preview line is left out');
  assert.doesNotMatch(text, /\n{3,}/, 'no runs of blank lines');
});

test("a table's rows come out a line each", () => {
  const text = email.toText(`<table><tr><td>Name</td><td>Sara</td></tr><tr><td>Email</td><td><a href="mailto:sara@example.com">sara@example.com</a></td></tr></table>`);
  assert.deepStrictEqual(text.split('\n'), ['Name Sara', 'Email sara@example.com'], 'an address link reads as the address');
});
