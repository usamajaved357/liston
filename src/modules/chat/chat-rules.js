// Team chat's rules, pure: one direct message per pair, what a conversation
// is called for each person, who is pushed about a message, quiet hours,
// and the one-line preview a list row or a notification shows.

const MAX_BODY = 8000;
const GROUP_MAX = 8; // a group DM: 3 to 8 people, more is a channel
const CHANNEL_NAME = /^[a-z0-9][a-z0-9-_]{0,59}$/;

/** The key that makes a direct message unique to its two people. */
const dmKey = (a, b) => [String(a), String(b)].sort().join(':');

/** A person's name to show: their name, else their email's first part. */
const nameOf = (p) => (p ? p.name || (p.email ? String(p.email).split('@')[0] : null) || 'Someone' : 'Someone');

/** A channel name as typed, made into one: lower case, hyphens for spaces, no "#". */
function channelName(raw) {
  return String(raw || '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

const validChannelName = (name) => CHANNEL_NAME.test(name);

/**
 * What a conversation is called for one person: "#flipx-orders", the other
 * person's name in a direct message, a group's name or its people's names.
 */
function titleOf(conversation, members, viewerId) {
  if (conversation.kind === 'channel') return `#${conversation.name}`;
  const others = members.filter((m) => String(m.user_id || m.id) !== String(viewerId));
  if (conversation.kind === 'dm') return others[0] ? nameOf(others[0]) : 'Just you';
  if (conversation.name) return conversation.name;
  const names = others.map(nameOf);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ') || 'Group';
}

/** "@channel", "@everyone" or "@here" in a message: everyone in it is mentioned. */
const mentionsEveryone = (body) => /(^|[\s(])@(channel|everyone|here)\b/i.test(String(body || ''));

/**
 * Whether a member is pushed about a message: never their own; muted
 * conversations and a person's "none" never; "mentions" (on the
 * conversation or in their settings) only a direct message or one that
 * mentions them.
 */
function wantsPush({ member, settings, conversation, message }) {
  if (!member || String(member.user_id) === String(message.author_user_id)) return false;
  if (member.notify === 'none') return false;
  const personal = conversation.kind === 'dm' || message.mention_all || (message.mentions || []).map(String).includes(String(member.user_id));
  if (member.notify === 'mentions' && !personal) return false;
  const chat = settings?.chat || 'all';
  if (chat === 'none') return false;
  if (chat === 'mentions' && !personal) return false;
  return true;
}

/** Whether `now` falls in a person's quiet hours (which may run past midnight). */
function inQuietHours(settings, now = new Date()) {
  if (!settings || settings.quiet_from === null || settings.quiet_from === undefined || settings.quiet_to === null || settings.quiet_to === undefined) return false;
  const from = Number(settings.quiet_from);
  const to = Number(settings.quiet_to);
  if (from === to) return false;
  let minutes;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: settings.time_zone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    minutes = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  } catch {
    minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

const CARD_WORDS = { order: 'an order', listing: 'a listing', draft: 'a draft', hunt: 'a hunted product' };

/**
 * One line for a list row or a notification: the text (to 140
 * characters), else what was shared ("Shared an order · FlipX", "Sent 3
 * photos").
 */
function previewOf({ body, fileCount = 0, imageCount = 0, cards = [], deleted = false }) {
  if (deleted) return 'Message deleted';
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  const card = cards.find(Boolean);
  if (card) return `Shared ${CARD_WORDS[card.kind] || 'something'}${card.account?.label ? ` · ${card.account.label}` : ''}`;
  if (imageCount && imageCount === fileCount) return imageCount === 1 ? 'Sent a photo' : `Sent ${imageCount} photos`;
  if (fileCount) return fileCount === 1 ? 'Sent a file' : `Sent ${fileCount} files`;
  return '';
}

module.exports = { dmKey, nameOf, channelName, validChannelName, titleOf, mentionsEveryone, wantsPush, inQuietHours, previewOf, MAX_BODY, GROUP_MAX };
