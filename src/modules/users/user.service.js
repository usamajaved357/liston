const bcrypt = require('bcrypt');
const userRepository = require('./user.repository');
const config = require('../../config');
const authService = require('../auth/auth.service');
const workspaceRepository = require('../team/workspace.repository');
const teams = require('../team/teams');

const SALT_ROUNDS = 12;

class UserError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * The signed-in person in the team they're in now (`ctx`: requireAuth's
 * userId, ownerId, role, coOwner): who they are, what they are there
 * ("owner" for the team's owner and anyone given owner access), that
 * team's plan and owner, and every team they can switch to (each with its
 * unread notifications).
 */
async function getCurrentUser(ctx) {
  const userId = typeof ctx === 'object' ? ctx.userId : ctx;
  const user = await userRepository.findByIdWithPlan(userId);
  if (!user) {
    throw new UserError('User not found', 404);
  }
  const ownerId = (typeof ctx === 'object' && ctx.ownerId) || user.id;
  const inOwn = String(ownerId) === String(user.id);
  const [owner, list] = await Promise.all([inOwn ? user : userRepository.findByIdWithPlan(ownerId), workspaceRepository.teamsFor(user.id)]);
  const teams = list.map((t) => ({
    id: t.id,
    name: t.name,
    ownerName: t.owner_name || t.owner_email,
    role: t.own ? 'owner' : t.owner_access_at ? 'owner_access' : 'member',
    unread: t.unread,
  }));
  return {
    ...user,
    // Lets the frontend show the "Access requests" admin page to the right people.
    is_admin: config.adminEmails.includes(String(user.email).toLowerCase()),
    role: (typeof ctx === 'object' && ctx.role) || user.role,
    owns_team: user.role === 'owner',
    owner_access: Boolean(typeof ctx === 'object' && ctx.coOwner),
    owner: inOwn || !owner ? null : { name: owner.name, email: owner.email },
    // The team's plan and accounts are its owner's.
    plan_id: owner?.plan_id ?? user.plan_id,
    plan_name: owner?.plan_name ?? user.plan_name,
    max_connections: owner?.max_connections ?? user.max_connections,
    listings_included_per_month: owner?.listings_included_per_month ?? user.listings_included_per_month,
    listings_used_this_month: owner?.listings_used_this_month ?? user.listings_used_this_month,
    connections_used: owner?.connections_used ?? user.connections_used,
    access_status: owner?.access_status ?? user.access_status,
    team: teams.find((t) => String(t.id) === String(ownerId)) || null,
    teams,
  };
}

/**
 * Deletes the person's login. An owner's team goes with it (its accounts,
 * listings, and the member logins in no other team); a member leaves every
 * team they're in. A login with owner access in a team is that team
 * owner's to remove, from the Team page.
 */
async function deleteAccount(userId) {
  const user = await userRepository.findRoleInfo(userId);
  if (!user) throw new UserError('User not found', 404);
  if (await userRepository.hasOwnerAccessAnywhere(userId)) {
    throw new UserError('Your login has owner access in a team, so only that team\'s owner can remove it, from their Team page.', 403);
  }
  if (user.role === 'owner') await userRepository.deleteLoginsOnlyIn(userId);
  await userRepository.deleteById(userId);
}

/** The team the person opens in next time (they switched to it). */
async function switchTeam(ctx, teamId) {
  const team = (ctx.teams || []).find((t) => String(t.ownerId) === String(teamId));
  if (!team) throw new UserError("You're not in that team.", 404);
  await workspaceRepository.setLast(ctx.userId, team.ownerId);
  return { id: team.ownerId, ...teams.roleIn(team) };
}

/** Which of the person's teams an eBay account is in, for a link from another team. */
async function teamOfConnection(userId, connectionId) {
  const ownerId = await workspaceRepository.teamOfConnection(userId, connectionId);
  if (!ownerId) throw new UserError('Not found', 404);
  return { id: ownerId };
}

async function assertCurrentPassword(userId, currentPassword) {
  const user = await userRepository.findAuthById(userId);
  if (!user) {
    throw new UserError('User not found', 404);
  }
  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) {
    throw new UserError('Current password is incorrect', 401);
  }
  return user;
}

async function changeEmail(userId, newEmail, currentPassword) {
  const user = await assertCurrentPassword(userId, currentPassword);

  if (newEmail.toLowerCase() === user.email.toLowerCase()) {
    throw new UserError('New email must be different from your current email', 400);
  }

  const taken = await userRepository.emailTakenByAnotherUser(newEmail, userId);
  if (taken) {
    throw new UserError('An account with this email already exists', 409);
  }

  await userRepository.updateEmail(userId, newEmail);
  // New address is unverified until proven — reuses the same token flow as signup.
  await authService.resendVerification(userId);
}

async function changePassword(userId, currentPassword, newPassword) {
  await assertCurrentPassword(userId, currentPassword);

  if (newPassword === currentPassword) {
    throw new UserError('New password must be different from your current password', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await userRepository.updatePasswordHash(userId, passwordHash);
}

const AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_AVATAR_BASE64_LENGTH = 1_400_000; // ~1MB decoded, comfortably under the route's JSON body limit

async function updateAvatar(userId, avatarDataUrl) {
  if (!AVATAR_DATA_URL_PATTERN.test(avatarDataUrl)) {
    throw new UserError('Avatar must be a PNG, JPEG or WebP image', 400);
  }
  if (avatarDataUrl.length > MAX_AVATAR_BASE64_LENGTH) {
    throw new UserError('Avatar image is too large. Please use one under 1MB', 400);
  }
  await userRepository.updateAvatar(userId, avatarDataUrl);
}

/**
 * Someone's own name, as their team sees it (who approved a product, in
 * notifications, histories and the Team pages). Owners and members alike;
 * the owner can also set a member's, in Team.
 */
async function updateName(userId, name) {
  const who = await userRepository.findRoleInfo(userId);
  if (!who) throw new UserError('User not found', 404);
  await userRepository.updateName(userId, name);
}

async function removeAvatar(userId) {
  await userRepository.updateAvatar(userId, null);
}

module.exports = {
  switchTeam,
  teamOfConnection,
  updateName,
  getCurrentUser,
  deleteAccount,
  changeEmail,
  changePassword,
  updateAvatar,
  removeAvatar,
  UserError,
};
