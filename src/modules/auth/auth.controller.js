const { z } = require('zod');
const authService = require('./auth.service');

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
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

module.exports = { signup, login, verifyEmail, resendVerification, forgotPassword, resetPassword };
