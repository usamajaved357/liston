const { z } = require('zod');
const authService = require('./auth.service');

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

async function signup(req, res, next) {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
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
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { user, token } = await authService.login(parsed.data);
    res.status(200).json({ user, token });
  } catch (err) {
    next(err);
  }
}

module.exports = { signup, login };
