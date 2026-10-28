const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../site/marketplace-workflow.js');
const history = require('../site/submissions.js');
const home = require('../site/solarpunk-home.js');
const fixture = require('./fixtures/funded-bounty.cjs').opportunity;
const item = { ...fixture, opportunity_id: `canonical:base-mainnet:${fixture.source_id}`, competition_mode: 'exclusive_claim', deadline: '2030-01-01T00:00:00Z' };
const status = (protocol, coverage, count) => ({ protocol, coverage, item_count: count, error: coverage === 'unavailable' ? 'read_model_unavailable' : null });
function projection() {
  return { schema_version: 'agent-bounties/opportunity-projection-v1', generated_at: '2026-10-17T02:00:00Z', network: 'base-mainnet', applied_view: 'ready_to_earn', degraded: true,
    coverage: 'partial', coverage_scope: 'inventory_page', requested_opportunity_id: null,
    source_statuses: [{source_type: 'canonical_base', available: false, coverage: 'partial', item_count: 1,
      protocol_statuses: [status('autonomous-v1', 'complete', 1), status('open-competition-v1', 'complete', 0), status('open-competition-v2-beta3', 'unavailable', null)]}], items: [structuredClone(item)] };
}
test('failed Beta3 leaves the healthy funded autonomous result usable and its count incomplete', () => {
  const result = flow.fundedInventory(projection());
  assert.deepEqual(result.items, [item]);
  assert.equal(result.coverage.state, 'partial');
  assert.deepEqual(result.coverage.missing, ['open-competition-v2-beta3']);
  assert.match(result.coverage.message, /full count is unknown/);
  const platform = { marketplace_payout_volume: { lifetime: { usdc: 5 }, lifetime_settled_rounds: 1 }, daily: [] };
  const snapshot = home.marketSnapshot(platform, projection(), Date.parse('2026-10-17T02:00:00Z'));
  assert.equal(snapshot.live, null);
  assert.equal(snapshot.availability.now, 1);
  assert.equal(snapshot.payout, 5);
});
test('all unavailable means unknown rather than a healthy zero; malformed partial data is rejected', () => {
  const payload = projection(); payload.items = []; payload.coverage = 'unavailable';
  const source = payload.source_statuses[0]; source.coverage = 'unavailable'; source.item_count = 0;
  source.protocol_statuses = source.protocol_statuses.map(s => status(s.protocol, 'unavailable', null));
  assert.equal(flow.fundedInventory(payload).coverage.state, 'unavailable');
  assert.match(flow.fundedInventory(payload).coverage.message, /number of bounties is unknown/);
  for (const mutate of [
    p => p.source_statuses[0].protocol_statuses.pop(),
    p => p.source_statuses[0].protocol_statuses[2].item_count = 0,
    p => p.source_statuses[0].available = true,
    p => p.coverage = 'complete',
    p => p.degraded = false,
    p => p.source_statuses[0].protocol_statuses[0].error = 'unavailable',
    p => p.source_statuses[0].protocol_statuses[0] = status('autonomous-v1', 'unavailable', null),
    p => p.items[0].verification_ready = false,
    p => p.items[0].payment_committed = false,
    p => p.items[0].network = 'base-sepolia',
  ]) { const changed = projection(); mutate(changed); assert.throws(() => flow.fundedInventory(changed)); }
});
test('exact identity coverage does not imply whole-protocol inventory coverage', () => {
  const payload = projection(); payload.applied_view = 'recent'; payload.degraded = false;
  payload.coverage = 'complete'; payload.coverage_scope = 'canonical_identity'; payload.requested_opportunity_id = item.opportunity_id;
  Object.assign(payload.source_statuses[0], {coverage: 'complete', available: true, protocol_statuses: [status('autonomous-v1', 'complete', 1)]});
  assert.equal(history.projection(payload, false, item.opportunity_id).items.length, 1);
  assert.throws(() => flow.canonicalCoverage(payload));
  assert.throws(() => history.projection(payload, false, item.opportunity_id + '0'));
});
test('partial paid history retains payment and canonical identity guards', () => {
  const payload = projection(); payload.applied_view = 'recent';
  Object.assign(payload.items[0], {work_state: 'completed', payment_state: 'paid', source_status: 'paid'});
  assert.equal(history.projection(payload, true).items.length, 1);
  payload.items[0].payment_state = 'escrowed';
  assert.throws(() => history.projection(payload, true));
});
test('the rendered board shows a healthy card and an explicit partial-list notice', async () => {
  const market = require('../site/marketplace.js');
  const nodes = new Map();
  const doc = { visibilityState: 'visible', querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {textContent:'', innerHTML:'', value: selector === '[data-market-timing]' ? 'all' : '', hidden:true,
      setAttribute() {}, addEventListener() {}, querySelector() { return null; }});
    return nodes.get(selector);
  }};
  const payload = projection();
  const win = {location:new URL('https://agentizable.ai/marketplace.html'), setInterval() {}, async fetch() {return {ok:true,json:async()=>payload};}};
  market.startBoard(win, doc);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get('[data-market-summary]').textContent, /full count is unknown/);
  assert.match(nodes.get('[data-market-summary]').textContent, /1 checked listings shown/);
  assert.ok(nodes.get('[data-opportunity-list]').innerHTML.includes(item.title));
});
test('ChatGPT widget distinguishes missing coverage from an empty checked page', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../crates/mcp-server/assets/chatgpt-bounty-feed-widget.html'), 'utf8');
  const source = html.slice(html.indexOf('        function coverageNotice('), html.indexOf('        function render()'));
  const context = {}; vm.runInNewContext(source, context);
  assert.match(context.coverageNotice({coverage:'partial'}), /full count is unknown/);
  assert.match(context.coverageNotice({coverage:'unavailable'}), /number of bounties is unknown/);
  assert.match(context.coverageNotice({degraded:true}), /unknown/);
  assert.equal(context.coverageNotice({coverage:'complete'}), '');
});
test('capped pages never become a full homepage inventory total', () => {
  for (const has_more of [true, undefined]) {
    const payload = projection(); payload.coverage = 'complete'; payload.degraded = false; payload.has_more = has_more;
    Object.assign(payload.source_statuses[0], {coverage:'complete',available:true,protocol_statuses:[status('autonomous-v1','complete',301),status('open-competition-v1','complete',0),status('open-competition-v2-beta3','complete',0)]});
    payload.items = Array.from({length:300}, (_,i) => ({...item, source_id:'0x'+(i+1).toString(16).padStart(40,'0'), opportunity_id:'canonical:base-mainnet:0x'+(i+1).toString(16).padStart(40,'0')}));
    const result = home.marketSnapshot({marketplace_payout_volume:{lifetime:{usdc:5},lifetime_settled_rounds:1},daily:[]},payload,Date.parse('2026-10-17T02:00:00Z'));
    assert.equal(result.live, null);
    assert.equal(result.availability.now, 300);
    assert.equal(result.coverage.limited, true);
    assert.match(result.coverage.message,/limited page.*full count is unknown/);
  }
});
