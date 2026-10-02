// Team chat's rules, pure: one direct message per pair, what a conversation
// is called for each person, who is pushed about a message (or a thread
// reply), quiet hours, what makes a voice note, and the one-line preview a
// list row or a notification shows.

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

/**
 * Whether a follower of a thread (or someone mentioned in a reply) is
 * pushed about a new reply there: never their own; not in a conversation
 * they muted; their "none" never; following a thread or being mentioned
 * counts as being spoken to, so "mentions" lets it through.
 */
function wantsThreadPush({ member, follower, settings, message }) {
  if (!member || String(member.user_id) === String(message.author_user_id)) return false;
  if (member.notify === 'none') return false;
  const mentioned = message.mention_all || (message.mentions || []).map(String).includes(String(member.user_id));
  if (!follower && !mentioned) return false;
  if ((settings?.chat || 'all') === 'none') return false;
  return true;
}

// A voice note: up to ten minutes, its sound's shape as up to 64 bars from 0 to 1.
const VOICE_MAX_MS = 10 * 60 * 1000;
const VOICE_BARS = 64;

/**
 * A voice note as kept on its message, from what the page sent and the
 * file it uploaded: { fileId, durationMs, peaks }, or null when it isn't
 * one (no such file, not audio, no length).
 */
function voiceOf(input, file) {
  if (!input || !file || String(input.fileId) !== String(file.id)) return null;
  if (!/^audio\//i.test(String(file.mime || ''))) return null;
  const durationMs = Math.round(Number(input.durationMs));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const peaks = (Array.isArray(input.peaks) ? input.peaks : [])
    .slice(0, VOICE_BARS)
    .map((p) => Math.round(Math.min(1, Math.max(0, Number(p) || 0)) * 100) / 100);
  return { fileId: String(file.id), durationMs: Math.min(durationMs, VOICE_MAX_MS), peaks };
}

/** A length as a clock: "0:07", "1:42", "10:00". */
function clockOf(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Text with its formatting marks taken off ([words](link), **bold**, _italic_, ~struck~, `code`), for a one-line preview. */
function plainOf(text) {
  return String(text || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[^\w*])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/(^|[^\w~])~([^~\n]+)~(?!\w)/g, '$1$2');
}

const CARD_WORDS = { order: 'an order', listing: 'a listing', draft: 'a draft', hunt: 'a hunted product', conversation: 'an eBay conversation' };

/**
 * One line for a list row or a notification: the text (to 140
 * characters), else what was shared ("Voice message (0:12)", "Shared an
 * order · FlipX", "Sent 3 photos").
 */
function previewOf({ body, fileCount = 0, imageCount = 0, cards = [], deleted = false, voiceMs = null }) {
  if (deleted) return 'Message deleted';
  const text = plainOf(body).replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  if (voiceMs !== null && voiceMs !== undefined && Number(voiceMs) > 0) return `Voice message (${clockOf(voiceMs)})`;
  const card = cards.find(Boolean);
  if (card) return `Shared ${CARD_WORDS[card.kind] || 'something'}${card.account?.label ? ` · ${card.account.label}` : ''}`;
  if (imageCount && imageCount === fileCount) return imageCount === 1 ? 'Sent a photo' : `Sent ${imageCount} photos`;
  if (fileCount) return fileCount === 1 ? 'Sent a file' : `Sent ${fileCount} files`;
  return '';
}

module.exports = { dmKey, nameOf, channelName, validChannelName, titleOf, mentionsEveryone, wantsPush, wantsThreadPush, inQuietHours, previewOf, plainOf, voiceOf, clockOf, MAX_BODY, GROUP_MAX, VOICE_MAX_MS, VOICE_BARS };
