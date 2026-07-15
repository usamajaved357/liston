const userRepository = require('./user.repository');

async function getCurrentUser(userId) {
  const user = await userRepository.findByIdWithPlan(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return user;
}

async function deleteAccount(userId) {
  await userRepository.deleteById(userId);
}

module.exports = { getCurrentUser, deleteAccount };
