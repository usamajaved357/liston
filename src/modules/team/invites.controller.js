const { z } = require('zod');
const invitesService = require('./invites.service');

// Invitations: the workspace's side (the Members page: invite, resend,
// withdraw, a member's email change) and the invited person's (the page
// their link opens: what it is, and accepting it).

const actorOf = (req) => ({ userId: req.userId, coOwner: Boolean(req.coOwner) });
const UUID = /^[0-9a-f-]{36}$/i;
const gone = (res) => res.status(404).json({ error: 'That invitation was accepted or withdrawn already.' });

// An invitation's refusal carries a code the invitation page acts on (expired, used, password needed).
function fail(err, res, next) {
  if (err instanceof invitesService.InviteError) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  return next(err);
}

const inviteSchema = z.object({
  email: z.string().trim().email('Enter their email address.'),
  name: z.string().trim().max(100).optional(),
  // A member whose access they get on joining.
  sameAs: z.string().uuid().nullable().optional(),
});

async function listInvites(req, res, next) {
  try {
    res.status(200).json({ invites: await invitesService.listInvites(req.ownerId) });
  } catch (err) {
    next(err);
  }
}

async function invite(req, res, next) {
  try {
    const parsed = inviteSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const out = await invitesService.invite(req.ownerId, { email: parsed.data.email, name: parsed.data.name || null, sameAs: parsed.data.sameAs || null }, actorOf(req));
    res.status(out.again ? 200 : 201).json(out);
  } catch (err) {
    fail(err, res, next);
  }
}

async function resend(req, res, next) {
  if (!UUID.test(req.params.inviteId)) return gone(res);
  try {
    res.status(200).json(await invitesService.resend(req.ownerId, req.params.inviteId));
  } catch (err) {
    fail(err, res, next);
  }
}

async function revoke(req, res, next) {
  if (!UUID.test(req.params.inviteId)) return gone(res);
  try {
    await invitesService.revoke(req.ownerId, req.params.inviteId);
    res.status(204).end();
  } catch (err) {
    fail(err, res, next);
  }
}

const emailSchema = z.object({ email: z.string().trim().email('Enter their real email address.') });

async function changeMemberEmail(req, res, next) {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Member not found' });
  try {
    const parsed = emailSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    res.status(201).json(await invitesService.changeMemberEmail(req.ownerId, req.params.id, parsed.data.email, actorOf(req)));
  } catch (err) {
    fail(err, res, next);
  }
}

// ---- the invited person (no sign-in needed) ----

async function view(req, res, next) {
  try {
    res.status(200).json({ invite: await invitesService.view(req.params.token) });
  } catch (err) {
    fail(err, res, next);
  }
}

const acceptSchema = z.object({
  name: z.string().trim().max(100).optional(),
  password: z.string().max(200).optional(),
});

async function accept(req, res, next) {
  try {
    const parsed = acceptSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    res.status(200).json(await invitesService.accept(req.params.token, { ...parsed.data, authorization: req.headers.authorization || null }));
  } catch (err) {
    fail(err, res, next);
  }
}

// Someone already on Liston who can't sign in: a new-password link to the invited address.
async function passwordLink(req, res, next) {
  try {
    res.status(200).json(await invitesService.sendPasswordLink(req.params.token));
  } catch (err) {
    fail(err, res, next);
  }
}

module.exports = { listInvites, invite, resend, revoke, changeMemberEmail, view, accept, passwordLink };
