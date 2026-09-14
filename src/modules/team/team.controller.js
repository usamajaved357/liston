const { z } = require('zod');
const teamService = require('./team.service');

const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const updatePermissionsSchema = z.object({
  permissions: z
    .array(
      z.object({
        connectionId: z.string().uuid().nullable().optional(),
        feature: z.string().min(1),
        allowed: z.boolean(),
      })
    )
    .min(1, 'At least one permission change is required'),
});

async function listMembers(req, res, next) {
  try {
    const members = await teamService.listMembers(req.ownerId);
    res.status(200).json({ members, knownFeatures: teamService.KNOWN_FEATURES });
  } catch (err) {
    next(err);
  }
}

async function addMember(req, res, next) {
  try {
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const member = await teamService.addMember(req.ownerId, parsed.data);
    res.status(201).json({ member });
  } catch (err) {
    next(err);
  }
}

async function removeMember(req, res, next) {
  try {
    await teamService.removeMember(req.params.id, req.ownerId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function getMemberPermissions(req, res, next) {
  try {
    const permissions = await teamService.getMemberPermissions(req.params.id, req.ownerId);
    res.status(200).json({ permissions });
  } catch (err) {
    next(err);
  }
}

async function updateMemberPermissions(req, res, next) {
  try {
    const parsed = updatePermissionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const permissions = await teamService.updateMemberPermissions(req.params.id, req.ownerId, parsed.data.permissions);
    res.status(200).json({ permissions });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMembers, addMember, removeMember, getMemberPermissions, updateMemberPermissions };
