const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
require('dotenv').config();

const { pool } = require('../../src/db/client');
const authService = require('../../src/modules/auth/auth.service');
const connectionService = require('../../src/modules/connections/connection.service');
const listingRepository = require('../../src/modules/listings/listing.repository');
const activityRepository = require('../../src/modules/team/activity.repository');

// The Drafts tab's rows say where each draft came from: the hunted product
// (hunter, approver, Discover or Product research), who drafted it (or that
// it drafted itself on approval) and who last worked on it.

test.after(async () => {
  await pool.end();
});

test('each draft comes with its hunted product, who drafted it and who last worked on it; one made by hand has none of the hunt', async () => {
  const owner = (await authService.signup({ email: `drafts-origin-${crypto.randomUUID()}@example.com`, password: 'testpassword123' })).user;
  await pool.query("UPDATE users SET name = 'Usama' WHERE id = $1", [owner.id]);
  const hunter = (await authService.signup({ email: `drafts-hunter-${crypto.randomUUID()}@example.com`, password: 'testpassword123' })).user;
  await pool.query("UPDATE users SET name = 'Sara' WHERE id = $1", [hunter.id]);
  const connection = await connectionService.createConnection(owner.id, { platformKey: 'ebay', label: 'Origin Store', credentials: { accessToken: 'x' } });
  const content = { title: 'Lamp', description: 'x', imageUrls: [], price: { value: '9.99', currency: 'GBP' }, quantity: 1 };
  const hunted = await listingRepository.createDraft({ connectionId: connection.id, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: content });
  const byHand = await listingRepository.createDraft({ connectionId: connection.id, sku: null, platformOfferId: null, platformGroupKey: null, generatedData: { ...content, title: 'Fan' } });

  await pool.query(
    `INSERT INTO hunted_products (owner_user_id, connection_id, hunter_user_id, reviewer_user_id, status, title, currency, check_result, listing_id, added_from)
     VALUES ($1, $2, $3, $1, 'approved', 'Lamp', 'GBP', '{}'::jsonb, $4, 'research')`,
    [owner.id, connection.id, hunter.id, hunted.id]
  );
  await activityRepository.record({ actorUserId: owner.id, ownerUserId: owner.id, connectionId: connection.id, kind: 'listing.drafted', subjectType: 'draft', subjectId: hunted.id, detail: { automatic: true } });
  await activityRepository.record({ actorUserId: owner.id, ownerUserId: owner.id, connectionId: connection.id, kind: 'listing.drafted', subjectType: 'draft', subjectId: byHand.id });
  await activityRepository.record({ actorUserId: hunter.id, ownerUserId: owner.id, connectionId: connection.id, kind: 'listing.draft_edited', subjectType: 'draft', subjectId: byHand.id });

  const rows = await listingRepository.findPendingByConnection(connection.id, owner.id);
  const byId = new Map(rows.map((r) => [r.id, r.origin]));
  const fromHunt = byId.get(hunted.id);
  assert.strictEqual(fromHunt.hunt.addedFrom, 'research');
  assert.deepStrictEqual([fromHunt.hunt.hunter.name, fromHunt.hunt.reviewer.name], ['Sara', 'Usama']);
  assert.deepStrictEqual([fromHunt.draftedBy.name, fromHunt.draftedAutomatically, fromHunt.lastEdit], ['Usama', true, null]);
  const handMade = byId.get(byHand.id);
  assert.strictEqual(handMade.hunt, null);
  assert.deepStrictEqual([handMade.draftedBy.name, handMade.draftedAutomatically], ['Usama', false]);
  assert.strictEqual(handMade.lastEdit.by.name, 'Sara');
  assert.ok(handMade.lastEdit.at);
  assert.ok(!('hunter_name' in rows[0]), 'only the shaped origin, not the raw columns');
});
