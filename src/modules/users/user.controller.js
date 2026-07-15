const { z } = require('zod');
const userService = require('./user.service');

const changeEmailSchema = z.object({
  email: z.string().email(),
  currentPassword: z.string().min(1, 'Current password is required'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

async function getMe(req, res, next) {
  try {
    const user = await userService.getCurrentUser(req.userId);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

async function deleteAccount(req, res, next) {
  try {
    await userService.deleteAccount(req.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function updateEmail(req, res, next) {
  try {
    const parsed = changeEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await userService.changeEmail(req.userId, parsed.data.email, parsed.data.currentPassword);
    res.status(200).json({ message: 'Email updated. Check your inbox to verify the new address.' });
  } catch (err) {
    next(err);
  }
}

async function updatePassword(req, res, next) {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await userService.changePassword(req.userId, parsed.data.currentPassword, parsed.data.newPassword);
    res.status(200).json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, deleteAccount, updateEmail, updatePassword };
