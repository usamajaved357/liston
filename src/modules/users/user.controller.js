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

const updateNameSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(60, 'Keep your name under 60 characters.'),
});

const updateAvatarSchema = z.object({
  avatarUrl: z.string().min(1, 'Avatar image is required'),
});

async function getMe(req, res, next) {
  try {
    const user = await userService.getCurrentUser({ userId: req.userId, ownerId: req.ownerId, role: req.role, coOwner: req.coOwner });
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

async function updateName(req, res, next) {
  try {
    const parsed = updateNameSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await userService.updateName(req.userId, parsed.data.name);
    res.status(200).json({ message: 'Name updated', name: parsed.data.name });
  } catch (err) {
    next(err);
  }
}

async function updateAvatar(req, res, next) {
  try {
    const parsed = updateAvatarSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await userService.updateAvatar(req.userId, parsed.data.avatarUrl);
    res.status(200).json({ message: 'Profile photo updated' });
  } catch (err) {
    next(err);
  }
}

async function deleteAvatar(req, res, next) {
  try {
    await userService.removeAvatar(req.userId);
    res.status(200).json({ message: 'Profile photo removed' });
  } catch (err) {
    next(err);
  }
}

const switchTeamSchema = z.object({ id: z.string().uuid() });

// The team the person switched to: where they open next time.
async function switchTeam(req, res, next) {
  try {
    const parsed = switchTeamSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Pick a workspace.' });
    res.status(200).json({ team: await userService.switchTeam({ userId: req.userId, teams: req.teams }, parsed.data.id) });
  } catch (err) {
    next(err);
  }
}

// Which of the person's teams an eBay account is in (a link opened from another team).
async function teamOfConnection(req, res, next) {
  try {
    const connectionId = String(req.query.connectionId || '');
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return res.status(400).json({ error: 'Which account?' });
    res.status(200).json({ team: await userService.teamOfConnection(req.userId, connectionId) });
  } catch (err) {
    next(err);
  }
}

module.exports = { switchTeam, teamOfConnection, getMe, deleteAccount, updateEmail, updatePassword, updateName, updateAvatar, deleteAvatar };
