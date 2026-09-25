const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();

const aiUsage = require('../../src/modules/ai-generation/ai-usage');

test.afterEach(() => aiUsage._reset());

test('a call is priced from its own token counts, per model, cache reads and writes included', () => {
  assert.strictEqual(aiUsage.costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-haiku-4-5-20251001'), 6);
  assert.strictEqual(aiUsage.costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-sonnet-4-5'), 18);
  assert.strictEqual(aiUsage.costOf({ cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }, 'claude-haiku-4-5'), 1.25 + 0.1);
});

test("the day's spend is split by feature, biggest first, and a response without usage is ignored", async () => {
  aiUsage.record('draft.write', { model: 'claude-haiku-4-5', usage: { input_tokens: 6000, output_tokens: 1500 } });
  aiUsage.record('draft.write', { model: 'claude-haiku-4-5', usage: { input_tokens: 4000, output_tokens: 500 } });
  aiUsage.record('editor.revise', { model: 'claude-haiku-4-5', usage: { input_tokens: 3000, output_tokens: 100 } });
  aiUsage.record('research', {});
  const { days, purposes } = await aiUsage.snapshot(3);
  assert.strictEqual(days.length, 3);
  const today = days[0];
  assert.deepStrictEqual(
    today.byPurpose.map((r) => [r.purpose, r.calls, r.input, r.output, r.cost]),
    [
      ['draft.write', 2, 10000, 2000, 0.02],
      ['editor.revise', 1, 3000, 100, 0.0035],
    ]
  );
  assert.strictEqual(today.total, 0.0235);
  assert.strictEqual(today.calls, 3);
  assert.strictEqual(today.byPurpose[0].label, purposes['draft.write']);
  assert.deepStrictEqual(days[1].byPurpose, []);
});
