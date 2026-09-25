const config = require('../../config');
const logger = require('../../utils/logger');
const appState = require('../../db/app-state.repository');

// What every Claude call costs, by what it was for: drafting, editor edits,
// category moves, policy-word fixes, research. Read from each response's
// own token counts (response.usage), priced per model, and kept per UTC day
// for a month so the admin can see which feature the bill comes from.
// Process-local with the counts saved to app_state, like the eBay usage.

const STATE_KEY = 'claude-usage';
const KEEP_DAYS = 31;
const PERSIST_DEBOUNCE_MS = 5 * 1000;

// $ per million tokens, input / output (Anthropic's list prices). Cache
// writes cost 1.25× input, cache reads 0.1×.
const PRICES = [
  { match: /haiku-4-5|haiku-4\.5/, input: 1, output: 5 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /sonnet-4-6|sonnet-4-5|sonnet-4/, input: 3, output: 15 },
  { match: /opus-5-5/, input: 4, output: 20 },
  { match: /opus/, input: 5, output: 25 },
];
const priceFor = (model) => PRICES.find((p) => p.match.test(String(model || ''))) || PRICES[0];

// What each purpose is called on the admin page.
const PURPOSES = {
  'draft.write': 'Drafting: writing the listing',
  'draft.title': 'Drafting: title top-up',
  'draft.refit': 'Category change',
  'editor.revise': 'Editor AI edits & recommended changes',
  'editor.policy': 'Fix policy words',
  'editor.photo': 'Editor photo edits',
  research: 'Product research advice',
};

const state = { days: {} }; // { 'YYYY-MM-DD': { [purpose]: { calls, input, output, cacheWrite, cacheRead, cost } } }
let loaded = false;
let persistTimer = null;

const today = () => new Date().toISOString().slice(0, 10);

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await appState.get(STATE_KEY);
    if (saved?.days) {
      // Counts made before this load (a call during start-up) are added in.
      for (const [day, purposes] of Object.entries(saved.days)) {
        for (const [purpose, row] of Object.entries(purposes)) add(day, purpose, row);
      }
    }
  } catch (err) {
    logger.warn('Could not load Claude usage', { error: err.message });
  }
}

function add(day, purpose, row) {
  const bucket = (state.days[day] ||= {});
  const into = (bucket[purpose] ||= { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
  for (const key of Object.keys(into)) into[key] += Number(row[key]) || 0;
}

function prune() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(state.days)) if (day < cutoff) delete state.days[day];
}

function schedulePersist() {
  if (persistTimer || config.env === 'test') return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    appState.set(STATE_KEY, { days: state.days }).catch((err) => logger.warn('Could not save Claude usage', { error: err.message }));
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

/** What one response's tokens cost, in dollars. */
function costOf(usage = {}, model = config.aiModel) {
  const price = priceFor(model);
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  return (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1 + output * price.output) / 1e6;
}

/** Counts one Claude response under `purpose`. Never throws. */
function record(purpose, response) {
  try {
    const usage = response?.usage;
    if (!usage) return;
    add(today(), purpose, {
      calls: 1,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cost: costOf(usage, response.model || config.aiModel),
    });
    prune();
    schedulePersist();
  } catch (err) {
    logger.warn('Could not count a Claude call', { error: err.message });
  }
}

/**
 * The last `days` days, newest first: { model, days: [{ day, total, byPurpose:
 * [{ purpose, label, calls, input, output, cost }] }], purposes }.
 */
async function snapshot(days = 14) {
  await load();
  prune();
  const list = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rows = Object.entries(state.days[day] || {})
      .map(([purpose, r]) => ({ purpose, label: PURPOSES[purpose] || purpose, calls: r.calls, input: r.input + r.cacheWrite + r.cacheRead, output: r.output, cost: Math.round(r.cost * 10000) / 10000 }))
      .sort((a, b) => b.cost - a.cost);
    list.push({ day, total: Math.round(rows.reduce((sum, r) => sum + r.cost, 0) * 10000) / 10000, calls: rows.reduce((sum, r) => sum + r.calls, 0), byPurpose: rows });
  }
  return { model: config.aiModel, days: list, purposes: PURPOSES };
}

/** Test hook. */
function _reset() {
  state.days = {};
  loaded = true;
}

module.exports = { record, snapshot, costOf, load, PURPOSES, _reset };
