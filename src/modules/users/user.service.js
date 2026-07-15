const bcrypt = require('bcrypt');
const userRepository = require('./user.repository');
const authService = require('../auth/auth.service');

const SALT_ROUNDS = 12;

class UserError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function getCurrentUser(userId) {
  const user = await userRepository.findByIdWithPlan(userId);
  if (!user) {
    throw new UserError('User not found', 404);
  }
  return user;
}

async function deleteAccount(userId) {
  await userRepository.deleteById(userId);
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

module.exports = { getCurrentUser, deleteAccount, changeEmail, changePassword, UserError };
