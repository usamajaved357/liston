const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireAnyFeature } = require('../../middleware/feature.middleware');
const huntingRepository = require('./hunting.repository');
const huntingController = require('./hunting.controller');

// One hunted product's routes (/api/hunting/:huntId). The account comes from
// the product itself; anyone who hunts, reviews or drafts on it gets past
// this gate, and the service decides what each of them may do.
const HUNTING_ACCESS = ['hunting', 'hunting_review', 'listings'];

async function connectionOfHunt(req) {
  const hunt = await huntingRepository.findForOwner(req.params.huntId, req.ownerId);
  return hunt?.connection_id;
}

const router = express.Router();
const guard = [requireAuth, requireAnyFeature(HUNTING_ACCESS, { resolveConnectionId: connectionOfHunt })];

router.get('/:huntId', ...guard, huntingController.detail);
router.patch('/:huntId', ...guard, huntingController.update);
router.delete('/:huntId', ...guard, huntingController.withdraw);
router.post('/:huntId/recheck', ...guard, huntingController.recheck);
router.post('/:huntId/resubmit', ...guard, huntingController.resubmit);
router.post('/:huntId/decision', ...guard, huntingController.decide);
router.post('/:huntId/draft', ...guard, huntingController.draftStart);

module.exports = router;
module.exports.HUNTING_ACCESS = HUNTING_ACCESS;
