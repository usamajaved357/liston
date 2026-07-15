const userService = require('./user.service');

async function getMe(req, res, next) {
  try {
    const user = await userService.getCurrentUser(req.userId);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe };
