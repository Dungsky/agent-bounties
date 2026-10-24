// Runs the posting page's real card-payment controller against a stubbed quote API: every refusal
// keeps the draft and says why, and only a confirmed quote id opens the order page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../site/bounty-composer-v2.js'), 'utf8');
const start = source.indexOf('  function syncCardPayment() {');
const end = source.indexOf('  async function openFunding() {', start);
assert.ok(start > 0 && end > start, 'card payment controller not found');

function controller(response) {
  const button = () => ({ hidden: true, disabled: true });
  const context = {
    API: 'https://api.agentbounties.app',
    ui: { card: button(), cardNote: button() },
    state: {
      draft: { title: 'T', goal: 'G', acceptance_criteria: ['C'], evidence_schema: { type: 'object' } },
      reviewStale: false, imageReady: true, postingAccountStatus: 'ready',
      deliveryDeadline: '2030-01-01T00:00:00Z', sourceUrl: null, bountyImage: null,
    },
    requests: [], statuses: [], opened: null, loggedIn: false,
    cardEligible: () => true,
    beginPostingLogin() { context.loggedIn = true; },
    canonicalJsonValue: value => value,
    stripVisualExtension: value => value,
    currentRewardSplit: () => ({ solver: 25000000n }),
    setStatus(message, kind) { context.statuses.push([kind, message]); },
    async fetch(url, init) { context.requests.push([url, JSON.parse(init.body)]); return response; },
    window: {
      AgentBountiesWorkflow: { UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ },
      location: { assign(url) { context.opened = url; } },
    },
  };
  const api = vm.runInNewContext(`${source.slice(start, end)}\n({ syncCardPayment, payByCard })`, context);
  return { ...api, context };
}

const ID = '11111111-1111-4111-8111-111111111111';

test('a confirmed quote opens its itemized order page and sends the exact solver reward', async () => {
  const { payByCard, context } = controller({ ok: true, json: async () => ({ quote: { input: { quote_id: ID } } }) });
  await payByCard();
  assert.equal(context.opened, `account.html?managed_quote=${ID}`);
  const [url, body] = context.requests[0];
  assert.equal(url, 'https://api.agentbounties.app/v1/managed-service/bounty-quotes');
  assert.equal(body.solver_reward_micro_usdc, 25000000);
  assert.equal(body.document.benchmark.engine, 'customer_review_v1');
});

for (const [status, text] of [
  [422, /above the current card payment limit/],
  [503, /isn't available right now/],
  [401, /Sign in again/],
  [400, /can't be paid by card/],
]) {
  test(`a ${status} refusal keeps the draft, opens nothing and re-enables the button`, async () => {
    const { payByCard, context } = controller({ ok: false, status, json: async () => ({}) });
    await payByCard();
    assert.equal(context.opened, null);
    assert.deepEqual(context.statuses.at(-1)[0], 'error');
    assert.match(context.statuses.at(-1)[1], text);
    assert.equal(context.ui.card.disabled, false);
  });
}

test('an unconfirmed quote id opens nothing', async () => {
  const { payByCard, context } = controller({ ok: true, json: async () => ({ quote: { input: { quote_id: 'not-a-uuid' } } }) });
  await payByCard();
  assert.equal(context.opened, null);
  assert.match(context.statuses.at(-1)[1], /could not be confirmed\. Nothing was charged/);
});

test('a signed-out poster is sent to login before any quote request', async () => {
  const { payByCard, context } = controller({ ok: true, json: async () => ({}) });
  context.state.postingAccountStatus = 'checking';
  await payByCard();
  assert.equal(context.loggedIn, true);
  assert.equal(context.requests.length, 0);
});
