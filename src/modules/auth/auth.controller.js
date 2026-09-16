const { z } = require('zod');
const authService = require('./auth.service');
const accessService = require('./access.service');
const config = require('../../config');

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().trim().max(80).optional(),
  // "Tell us about your business" — shown to the admin reviewing the request.
  accessNote: z.string().trim().max(500).optional(),
});

// Login only needs a password to be present — enforcing today's minimum
// length here would reject correct logins for any account created before
// the rule existed (or after a future length change).
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

const tokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

const emailSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

async function signup(req, res, next) {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { user, token } = await authService.signup(parsed.data);
    res.status(201).json({ user, token });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { user, token } = await authService.login(parsed.data);
    res.status(200).json({ user, token });
  } catch (err) {
    next(err);
  }
}

async function verifyEmail(req, res, next) {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { user } = await authService.verifyEmail(parsed.data.token);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

async function resendVerification(req, res, next) {
  try {
    await authService.resendVerification(req.userId);
    res.status(200).json({ message: 'Verification email sent' });
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await authService.requestPasswordReset(parsed.data.email);
    // Same response whether or not the email exists — avoids account enumeration
    res.status(200).json({ message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await authService.resetPassword(parsed.data.token, parsed.data.password);
    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
}

// One-click links from the admin email. These are browser navigations, so
// they end on a small confirmation page rather than JSON.
function decisionPage(res, title, body) {
  res
    .status(200)
    .type('html')
    .send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 20px;color:#0f172a"><h2>${title}</h2><p style="color:#475569">${body}</p><p><a href="${config.frontendUrl}" style="color:#4f46e5">Open Liston</a></p></body>`);
}

async function accessDecision(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  try {
    const user = await accessService.decide(token);
    const approved = user.access_status === 'active';
    const outcome = approved
      ? 'approved and emailed a login link'
      : user.deleted
        ? 'notified and their account removed'
        : "notified and their access revoked. Their data is kept";
    decisionPage(res, approved ? 'Access approved' : 'Access rejected', `${user.email} has been ${outcome}.`);
  } catch (err) {
    decisionPage(res, "That link didn't work", err.message || 'It may have expired. Use the Access requests page in Liston instead.');
  }
}

async function listAccessRequests(req, res, next) {
  try {
    const [requests, reviewed] = await Promise.all([accessService.listPending(), accessService.listReviewed()]);
    res.status(200).json({ requests, reviewed });
  } catch (err) {
    next(err);
  }
}

const accessStatusSchema = z.object({ status: z.enum(['active', 'rejected']) });
async function setAccessStatus(req, res, next) {
  try {
    const parsed = accessStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    res.status(200).json({ user: await accessService.setStatus(req.params.userId, parsed.data.status) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  accessDecision,
  listAccessRequests,
  setAccessStatus, signup, login, verifyEmail, resendVerification, forgotPassword, resetPassword };
