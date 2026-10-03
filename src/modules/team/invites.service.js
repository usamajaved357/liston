const bcrypt = require('bcrypt');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const emailService = require('../../utils/email');
const authService = require('../auth/auth.service');
const notificationsService = require('../notifications/notifications.service');
const activityRepository = require('./activity.repository');
const invitesRepository = require('./invites.repository');
const teamRepository = require('./team.repository');
const teamService = require('./team.service');

// Joining a workspace is by invitation, as on Slack: the owner or a
// co-manager invites an email, Liston emails it a link, and the person
// joins from there — someone new choosing their own name and password,
// someone already on Liston with the login they have (signed in, or typing
// its password). Their access starts empty, or as another member's when the
// invitation said so. Nobody is in a workspace without accepting, and nobody
// but the person knows their password.
//
// The same link confirms a member's email: a login made before invitations
// (its email typed by the owner, never proven) has the address confirmed,
// or moves to their real one, once its person opens the link there and
// chooses a password. Nobody but the person ever sets a member's password:
// lost, it's Forgot password, or this link sent again.
//
// A link is the invitation's id and a signature of it (HMAC with the
// server's secret), so it can be shown again ("Copy link") without being
// stored; it works while the invitation is open: not accepted, withdrawn or
// past its 7 days (resending gives 7 more).

const SALT_ROUNDS = 12;
const DAYS = 7;
const MAX_OPEN = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InviteError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const sign = (id) => crypto.createHmac('sha256', config.jwt.secret).update(`workspace-invite:${id}`).digest('base64url');
const tokenOf = (id) => `${id}.${sign(id)}`;
const linkOf = (id) => `${config.frontendUrl}/invite/${tokenOf(id)}`;

/** The invitation id a link names, or null for one that isn't Liston's. */
function idOf(token) {
  const [id, sig] = String(token || '').split('.');
  if (!UUID.test(id || '') || !sig) return null;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? id.toLowerCase() : null;
}

const expiry = (now = Date.now()) => new Date(now + DAYS * 24 * 3600e3);
const whoIs = (row, prefix) => row[`${prefix}_name`] || row[`${prefix}_email`] || null;
const cleanEmail = (email) => String(email || '').trim().toLowerCase();

/** An open invitation as the Members page shows it. */
function shape(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    kind: row.member_user_id ? 'email' : 'join',
    memberId: row.member_user_id || null,
    existingLogin: Boolean(row.existing_login),
    invitedBy: whoIs(row, 'invited_by'),
    sameAs: row.same_as_user_id ? { id: row.same_as_user_id, name: whoIs(row, 'same_as') } : null,
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
    expired: new Date(row.expires_at).getTime() <= Date.now(),
    link: linkOf(row.id),
  };
}

async function listInvites(ownerId) {
  return (await invitesRepository.listOpen(ownerId)).map(shape);
}

async function openForOwner(ownerId, inviteId) {
  const rows = await invitesRepository.listOpen(ownerId);
  const row = rows.find((r) => String(r.id) === String(inviteId));
  if (!row) throw new InviteError('That invitation was accepted or withdrawn already.', 404);
  return row;
}

/**
 * Emails the invitation (the existing login told in the bell as well, the
 * first time). Whether the email went: a sandboxed sender or a refused
 * address doesn't, and the Members page offers its link to send another way.
 */
async function deliver(inviteId, { first = false } = {}) {
  const invite = await invitesRepository.findById(inviteId);
  const inviter = whoIs(invite, 'invited_by') || invite.owner_name || invite.owner_email;
  const team = invite.team_name || 'their workspace';
  const link = linkOf(invite.id);
  let result;
  if (invite.member_user_id) {
    result = await emailService.sendEmailChangeEmail(invite.email, { inviter, team, link, days: DAYS });
  } else {
    const login = await teamRepository.findLoginByEmail(invite.email);
    result = await emailService.sendWorkspaceInviteEmail(invite.email, { inviter, team, link, existingLogin: Boolean(login), days: DAYS });
    if (login && first) {
      // In whichever workspace they're in (no workspace: every bell shows it).
      await notificationsService.notify({
        userId: login.id,
        actorUserId: invite.invited_by,
        kind: 'team.invited',
        title: `${inviter} invited you to ${team}`,
        body: 'Open the invitation to join. You use the email and password you sign in with now.',
        url: `/invite/${tokenOf(invite.id)}`,
        subjectType: 'invite',
        subjectId: invite.id,
      });
    }
  }
  if (!result.sent && config.env !== 'production') {
    logger.info(`[DEV FALLBACK — no email sent] Workspace invitation for ${invite.email}`, { link });
  }
  return Boolean(result.sent);
}

/**
 * Invites an email into the workspace (`sameAs`: a member whose access the
 * person gets on joining). An email already invited is sent its invitation
 * again. Returns { invite, emailed }.
 */
async function invite(ownerId, { email, name = null, sameAs = null }, actor) {
  const address = cleanEmail(email);
  const login = await teamRepository.findLoginByEmail(address);
  if (login) {
    if (String(login.id) === String(ownerId)) throw new InviteError("That's the workspace owner's own login.", 400);
    const already = await teamRepository.findMemberForOwner(login.id, ownerId);
    if (already) {
      const who = already.name || already.email;
      throw new InviteError(already.deactivated_at ? `${who} was removed earlier. Restore them from Former members on the Members page instead.` : `${who} is already in this workspace.`, 409);
    }
  }
  if (sameAs) {
    const model = await teamRepository.findMemberForOwner(sameAs, ownerId);
    if (!model || model.deactivated_at) throw new InviteError('Pick a member who is in the workspace to copy their access.', 400);
  }
  const open = await invitesRepository.findOpenByEmail(ownerId, address);
  if (open) {
    await invitesRepository.markSent(open.id, expiry());
    const emailed = await deliver(open.id);
    return { invite: shape(await openForOwner(ownerId, open.id)), emailed, again: true };
  }
  if ((await invitesRepository.countOpen(ownerId)) >= MAX_OPEN) {
    throw new InviteError(`${MAX_OPEN} invitations are waiting already. Withdraw ones nobody will accept first.`, 429);
  }
  let id;
  try {
    id = await invitesRepository.create({ ownerId, email: address, name: name || null, sameAsUserId: sameAs || null, invitedBy: actor?.userId || ownerId, expiresAt: expiry() });
  } catch (err) {
    // The same email invited twice at once: the first one stands.
    if (err.code === '23505') throw new InviteError(`${address} was just invited.`, 409);
    throw err;
  }
  const emailed = await deliver(id, { first: true });
  return { invite: shape(await openForOwner(ownerId, id)), emailed, again: false };
}

/** Sends an open invitation again, open for another 7 days. */
async function resend(ownerId, inviteId) {
  await openForOwner(ownerId, inviteId);
  await invitesRepository.markSent(inviteId, expiry());
  const emailed = await deliver(inviteId);
  return { invite: shape(await openForOwner(ownerId, inviteId)), emailed };
}

async function revoke(ownerId, inviteId) {
  if (!(await invitesRepository.revoke(inviteId, ownerId))) throw new InviteError('That invitation was accepted or withdrawn already.', 404);
}

/**
 * Confirms a member's email, or moves their login to a real one: the
 * address is sent a link, and the login takes it (with a password of their
 * own) once they open it. The same address confirms the one they have,
 * when it never was; that's also how someone locked out gets back in. Until
 * then they sign in as they do now. Only a login that's this workspace's
 * alone, never a co-manager's by another co-manager. Returns { invite, emailed }.
 */
async function changeMemberEmail(ownerId, memberId, email, actor) {
  const member = await teamService.manageable(actor, memberId, ownerId);
  const who = member.name || member.email;
  if (member.deactivated_at) throw new InviteError(`${who} was removed. Restore them first.`, 409);
  if (member.shared_login) {
    throw new InviteError(`${who} also signs in to another workspace on Liston, so only they can change their email, from their own Settings.`, 403);
  }
  const address = cleanEmail(email);
  if (address === cleanEmail(member.email) && member.email_confirmed) {
    throw new InviteError(`${who} confirmed this email already. If they've lost their password, they use Forgot password on the sign-in page.`, 400);
  }
  const taken = await teamRepository.findLoginByEmail(address);
  if (taken && String(taken.id) !== String(member.id)) throw new InviteError('Another Liston login uses that email.', 409);
  await invitesRepository.revokeChangeFor(memberId);
  const id = await invitesRepository.create({ ownerId, email: address, memberUserId: memberId, invitedBy: actor?.userId || ownerId, expiresAt: expiry() });
  const emailed = await deliver(id);
  return { invite: shape(await openForOwner(ownerId, id)), emailed };
}

/** The invitation a link names, open, or why it can't be used. */
async function openInvite(token) {
  const id = idOf(token);
  const invite = id && (await invitesRepository.findById(id));
  if (!invite) throw new InviteError("This invitation link isn't valid. Check you copied all of it, or ask for a new one.", 404, 'INVITE_INVALID');
  return invite;
}

function statusOf(invite) {
  if (invite.accepted_at) return 'accepted';
  if (invite.revoked_at) return 'revoked';
  if (new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  return 'open';
}

/** What the invitation page shows: the workspace, who sent it, and what the person does next. */
async function view(token) {
  const invite = await openInvite(token);
  const login = invite.member_user_id ? null : await teamRepository.findLoginByEmail(invite.email);
  return {
    email: invite.email,
    name: invite.name,
    workspace: invite.team_name,
    invitedBy: whoIs(invite, 'invited_by') || invite.owner_name || invite.owner_email,
    // new: they create their login; join: they have one; email: their login moves to this email.
    kind: invite.member_user_id ? 'email' : login ? 'join' : 'new',
    // When the login they join with was made: they may not remember it.
    loginSince: login?.created_at || null,
    currentEmail: invite.member_email || null,
    expiresAt: invite.expires_at,
    status: statusOf(invite),
  };
}

function refuseUnlessOpen(invite) {
  const status = statusOf(invite);
  if (status === 'accepted') throw new InviteError('This invitation has been used already. Log in to Liston instead.', 409, 'INVITE_USED');
  if (status === 'revoked') throw new InviteError('This invitation was withdrawn. Ask the workspace for a new one if you still need it.', 410, 'INVITE_REVOKED');
  if (status === 'expired') throw new InviteError('This invitation has expired. Ask the workspace to send it again.', 410, 'INVITE_EXPIRED');
}

/**
 * For someone invited whose email already has a Liston login they can't
 * sign in to: a link to choose a new password, emailed to that address
 * (only its owner can open it, never the inviter, who can copy the
 * invitation's own link), coming back to the invitation once it's set.
 */
async function sendPasswordLink(token) {
  const invite = await openInvite(token);
  refuseUnlessOpen(invite);
  if (invite.member_user_id || !(await teamRepository.findLoginByEmail(invite.email))) {
    throw new InviteError("This invitation makes a new login: choose your password on its page.", 400);
  }
  await authService.requestPasswordReset(invite.email, { next: `/invite/${token}`, joining: invite.team_name });
  return { email: invite.email };
}

const raced = () => new InviteError('This invitation has just been used or withdrawn. Reload the page.', 409, 'INVITE_USED');

/** Who's signed in on this request, when someone is (an Authorization header that checks out). */
async function viewerOf(authorization) {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  try {
    const payload = authService.verifyToken(authorization.slice('Bearer '.length));
    const login = await invitesRepository.findLoginById(payload.sub);
    // A sign-in from before the password last changed isn't them any more.
    return login && (Number(payload.sv) || 0) === (Number(login.session_version) || 0) ? login : null;
  } catch {
    return null;
  }
}

/**
 * Accepts the invitation a link names and signs the person in:
 *   someone new   — `name` and `password` make their login;
 *   on Liston     — signed in as that email, or `password` is its password;
 *   email change  — `password` is the one they choose from now on.
 * Returns { token, user: { id, email, name, role, team: { id } } }; the
 * workspace's inviter is told someone joined.
 */
async function accept(token, { name = null, password = null, authorization = null } = {}) {
  const invite = await openInvite(token);
  refuseUnlessOpen(invite);
  const ownerId = invite.owner_user_id;
  const needPassword = (message) => {
    if (!password || password.length < 8) throw new InviteError(message, 400, 'PASSWORD_NEEDED');
  };

  if (invite.member_user_id) {
    needPassword('Choose a password of at least 8 characters.');
    const done = await invitesRepository.acceptEmailChange(invite, { passwordHash: await bcrypt.hash(password, SALT_ROUNDS) });
    if (!done) throw raced();
    if (done.refused === 'gone') throw new InviteError("This login isn't in the workspace any more, so its email can't be changed from here.", 409);
    if (done.refused === 'shared') throw new InviteError('This login is used in another workspace too, so change its email from your own Settings instead.', 409);
    if (done.refused === 'taken') throw new InviteError('Another Liston login uses this email now.', 409);
    // A password of their own: every sign-in from before (the old password's) ends, on every device.
    await authService.endSessions(done.user.id);
    return signedIn(done.user, ownerId);
  }

  const login = await invitesRepository.findLogin(invite.email);
  if (!login) {
    needPassword('Choose a password of at least 8 characters.');
    let user;
    try {
      user = await invitesRepository.acceptNew(invite, { name: String(name || invite.name || '').trim().slice(0, 100) || null, passwordHash: await bcrypt.hash(password, SALT_ROUNDS) });
    } catch (err) {
      if (err.code === '23505') throw new InviteError('This email has a Liston login now. Reload the page and join with its password.', 409, 'INVITE_RELOAD');
      throw err;
    }
    if (!user) throw raced();
    await joined(invite, user);
    return signedIn(user, ownerId);
  }

  if (String(login.id) === String(ownerId)) throw new InviteError("That's this workspace owner's own login.", 400);
  const viewer = await viewerOf(authorization);
  const isThem = viewer && String(viewer.id) === String(login.id);
  if (!isThem) {
    if (!password) throw new InviteError(`Enter the password you use for ${invite.email} on Liston.`, 400, 'PASSWORD_NEEDED');
    if (!(await bcrypt.compare(password, login.password_hash))) throw new InviteError(`That isn't the password for ${invite.email}. Don't know it? Email yourself a link to set a new one, below.`, 401, 'WRONG_PASSWORD');
  }
  const there = await teamRepository.findMemberForOwner(login.id, ownerId);
  if (there?.deactivated_at) throw new InviteError('You were removed from this workspace earlier. Ask its owner to restore you.', 409);
  if (!(await invitesRepository.acceptExisting(invite, login.id))) throw raced();
  await notificationsService.readSubject(login.id, 'team.invited', invite.id);
  if (!there) await joined(invite, login);
  return signedIn(login, ownerId);
}

// Recorded as a sign-in in the workspace, and the inviter (and the owner) told.
async function joined(invite, user) {
  const ownerId = invite.owner_user_id;
  await activityRepository.record({ actorUserId: user.id, ownerUserId: ownerId, kind: 'session.login', subjectType: 'session', subjectId: user.id }).catch(() => {});
  const who = user.name || user.email;
  const told = [...new Set([invite.invited_by, ownerId].filter(Boolean).map(String))];
  for (const userId of told) {
    await notificationsService.notify({
      userId,
      ownerId,
      actorUserId: user.id,
      kind: 'team.joined',
      title: `${who} joined ${invite.team_name || 'the workspace'}`,
      body: invite.same_as_user_id ? 'They have the access of the member you picked. Open them to change it.' : 'Open them to choose what they can use.',
      url: `/team/${user.id}?tab=access`,
      subjectType: 'member',
      subjectId: user.id,
    });
  }
}

async function signedIn(user, ownerId) {
  const member = await teamRepository.findMemberForOwner(user.id, ownerId);
  const role = member?.owner_access_at ? 'owner' : 'member';
  return {
    token: authService.issueToken(user),
    user: { id: user.id, email: user.email, name: user.name || null, role, team: { id: ownerId } },
  };
}

module.exports = { listInvites, invite, resend, revoke, changeMemberEmail, view, accept, sendPasswordLink, idOf, tokenOf, linkOf, InviteError, DAYS };
