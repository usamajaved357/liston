const userService = require('./user.service');

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

module.exports = { getMe, deleteAccount };
