const bcrypt = require('bcrypt');
const teamRepository = require('./team.repository');
const connectionRepository = require('../connections/connection.repository');

const SALT_ROUNDS = 12;

class TeamError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function listMembers(ownerId) {
  const members = await teamRepository.listMembers(ownerId);
  return Promise.all(
    members.map(async (member) => ({
      ...member,
      permissions: await teamRepository.getPermissions(member.id),
    }))
  );
}

async function addMember(ownerId, { email, name, password }) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    return await teamRepository.createMember({ ownerId, email, name, passwordHash });
  } catch (err) {
    if (err.code === '23505') {
      throw new TeamError('An account with this email already exists', 409);
    }
    throw err;
  }
}

// Owners hand out member logins, so they can also reset one — the member's
// old password stops working immediately.
async function setMemberPassword(memberId, ownerId, password) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const updated = await teamRepository.setMemberPassword(memberId, ownerId, passwordHash);
  if (!updated) {
    throw new TeamError('Team member not found', 404);
  }
}

async function removeMember(memberId, ownerId) {
  const deleted = await teamRepository.deleteMember(memberId, ownerId);
  if (!deleted) {
    throw new TeamError('Team member not found', 404);
  }
}

async function getMemberPermissions(memberId, ownerId) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) {
    throw new TeamError('Team member not found', 404);
  }
  return teamRepository.getPermissions(memberId);
}

// permissions: [{ connectionId: string|null, feature: string, allowed: boolean|null }]
// connectionId null sets/overrides the member's global default for that
// feature (allowed must be a real boolean there — there's no higher-level
// default for it to fall back to). A real connectionId sets a per-connection
// override; `allowed: null` there means "clear the override and defer back
// to the global default" rather than "explicitly deny," which a hard
// `false` would be indistinguishable from once written. Every connectionId
// is verified to belong to this owner before being written, so an admin can
// never grant a member access to someone else's connection.
async function updateMemberPermissions(memberId, ownerId, permissions) {
  const member = await teamRepository.findMemberForOwner(memberId, ownerId);
  if (!member) {
    throw new TeamError('Team member not found', 404);
  }

  for (const { connectionId, feature, allowed } of permissions) {
    if (connectionId) {
      // eslint-disable-next-line no-await-in-loop -- each grant must be verified before the next is written
      const connection = await connectionRepository.findByIdForUser(connectionId, ownerId);
      if (!connection) {
        throw new TeamError('Connection not found', 404);
      }
    }
    if (allowed === null) {
      if (!connectionId) {
        throw new TeamError('The global default must be either allowed or denied', 400);
      }
      // eslint-disable-next-line no-await-in-loop
      await teamRepository.clearPermission({ memberId, connectionId, feature });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await teamRepository.setPermission({ memberId, connectionId: connectionId || null, feature, allowed });
    }
  }

  return teamRepository.getPermissions(memberId);
}

module.exports = {
  KNOWN_FEATURES: teamRepository.KNOWN_FEATURES,
  listMembers,
  addMember,
  removeMember,
  setMemberPassword,
  getMemberPermissions,
  updateMemberPermissions,
  TeamError,
};
