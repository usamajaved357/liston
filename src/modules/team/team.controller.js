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
        // null is valid only for a connectionId-scoped entry — it clears the
        // override back to "inherit the global default" (see team.service.js).
        allowed: z.boolean().nullable(),
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

const setPasswordSchema = z.object({ password: z.string().min(8, 'Password must be at least 8 characters') });
async function setMemberPassword(req, res, next) {
  try {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    await teamService.setMemberPassword(req.params.id, req.ownerId, parsed.data.password);
    res.status(204).send();
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

async function restoreMember(req, res, next) {
  try {
    await teamService.restoreMember(req.params.id, req.ownerId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

const rangeQuery = (q) => ({ range: typeof q.range === 'string' ? q.range : undefined, from: q.from, to: q.to });

async function getMemberOverview(req, res, next) {
  try {
    res.status(200).json(await teamService.getMemberOverview(req.ownerId, req.params.id, rangeQuery(req.query)));
  } catch (err) {
    next(err);
  }
}

async function getMemberActivity(req, res, next) {
  try {
    const q = req.query;
    const connectionId = typeof q.connectionId === 'string' && /^[0-9a-f-]{36}$/i.test(q.connectionId) ? q.connectionId : undefined;
    const before = typeof q.before === 'string' && q.before.length < 80 ? q.before : undefined;
    res.status(200).json(
      await teamService.getMemberActivity(req.ownerId, req.params.id, { ...rangeQuery(q), kind: typeof q.kind === 'string' ? q.kind : undefined, connectionId, before, limit: q.limit })
    );
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

module.exports = { listMembers, addMember, removeMember, restoreMember, setMemberPassword, getMemberPermissions, updateMemberPermissions, getMemberOverview, getMemberActivity };
