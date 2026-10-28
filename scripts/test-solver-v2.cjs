// Solver side of v2 and card bounties: the workspace signs a v2 claim bond only for the nonce
// bound to the solver's next round, and an appeal only as exact typed data whose EIP-712 hash
// equals the digest the API verifies. Vectors are pinned in the Rust tests.
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('../site/evm.js');
const evm = globalThis.AgentBountiesEvm;
const participate = require('../site/participate.js');
const card = require('../site/card-review-appeal.js');

const BOUNTY = '0x' + 'ab'.repeat(20);
const SOLVER = '0x' + '5e'.repeat(20);
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const word = (b) => '0x' + b.repeat(32);

test('v2 claim nonce matches the contract derivation pinned in Rust', () => {
  assert.equal(participate.v2ClaimNonce(evm, BOUNTY, SOLVER, 3),
    '0x4ced809acc3f3db6699c71a7e2e2e30a534fb7dc81a9b1a968dcf464a76a1b06');
  const item = { bounty_contract: BOUNTY, events: [
    { kind: 'bounty_claimed', contract_address: BOUNTY, data: { round: 1 } },
    { kind: 'bounty_claimed', contract_address: BOUNTY, data: { round: 2 } },
    { kind: 'bounty_claimed', contract_address: '0x' + '11'.repeat(20), data: { round: 9 } }] };
  assert.equal(participate.nextClaimRound(item), 3);
  assert.equal(participate.nextClaimRound({ bounty_contract: BOUNTY, events: [] }), 1);
});

test('a v2 bond is signed only as the exact round-bound receive authorization', () => {
  const now = 1_900_000_000;
  const item = { protocol_version: 'agent-bounties/autonomous-v2', bounty_contract: BOUNTY,
    events: [{ kind: 'bounty_claimed', contract_address: BOUNTY, data: { round: 2 } }] };
  const typed = () => ({ primaryType: 'ReceiveWithAuthorization', types: evm.receiveWithAuthorizationTypes(),
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: TOKEN },
    message: { from: SOLVER, to: BOUNTY, value: '500000', validAfter: '0', validBefore: String(now + 1800),
      nonce: participate.v2ClaimNonce(evm, BOUNTY, SOLVER, 3) } });
  const check = (t) => participate.validateClaimBondSignature(t, { contract: BOUNTY, wallet: SOLVER, amount: 500000, item }, evm, now);
  assert.equal(check(typed()).primaryType, 'ReceiveWithAuthorization');
  const bad = [
    (t) => { t.message.nonce = word('77'); },
    (t) => { t.message.nonce = participate.v2ClaimNonce(evm, BOUNTY, SOLVER, 2); },
    (t) => { t.message.to = '0x' + '99'.repeat(20); },
    (t) => { t.message.value = '500001'; },
    (t) => { t.message.from = '0x' + '44'.repeat(20); },
    (t) => { t.message.validBefore = String(now + 7200); },
    (t) => { t.domain.chainId = 84532; },
    (t) => { t.primaryType = 'TransferWithAuthorization'; t.types = evm.transferWithAuthorizationTypes(); },
  ];
  for (const change of bad) { const t = typed(); change(t); assert.throws(() => check(t), /bond signature differs/); }
  // A v1 bounty keeps its transfer authorization check.
  assert.throws(() => participate.validateClaimBondSignature(typed(), { contract: BOUNTY, wallet: SOLVER, amount: 500000,
    item: { ...item, protocol_version: undefined } }, evm, now), /wallet signature differs/);
});

function publicState(overrides = {}) {
  const verdict = { schema: 'agent-bounties/customer-review-v1', bounty_contract: BOUNTY, round: 2,
    submission_hash: word('11'), evidence_hash: word('33'), passed: false, reason: 'The report omits the requested benchmark.' };
  return { network: 'base-sepolia', bounty_contract: BOUNTY, bounty_status: 'submitted',
    pending_submission: { round: 2, solver: SOLVER, submission_hash: word('11'), evidence_hash: word('33'),
      verification_expires_at: 2_000_000_000, decide_by: 1_900_000_000, evidence: { artifact_reference: 'https://example.com/a' } },
    reviews: [{ document: verdict, response_hash: word('22'), decided_by: 'customer',
      appeal: { status: 'window_open', window_ends_at: 1_950_000_000, document: null, appeal_hash: null },
      ruling: null, attestation: null, signature: null }],
    deposit_payout: null, ...overrides };
}

// Minimal EIP-712 for the field types an appeal uses, independent of the page code.
function eip712(typed) {
  const enc = (type, value) => type === 'string' ? evm.keccak256Hex(evm.textHex(value)).slice(2)
    : type === 'address' ? evm.addressWord(value) : type === 'bytes32' ? value.slice(2) : evm.uint256Word(value);
  const hashStruct = (name, data) => {
    const fields = typed.types[name];
    const typeHash = evm.keccak256Hex(evm.textHex(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`)).slice(2);
    return evm.keccak256Hex('0x' + typeHash + fields.map((f) => enc(f.type, data[f.name])).join('')).slice(2);
  };
  return evm.keccak256Hex('0x1901' + hashStruct('EIP712Domain', typed.domain) + hashStruct(typed.primaryType, typed.message));
}

test('the appeal the page signs hashes to the digest the API verifies', () => {
  const model = card.cardReview(publicState(), BOUNTY, 'base-sepolia');
  const review = { ...model.reviews[0], round: 2, submission_hash: word('11'), rejection_hash: word('22') };
  const typed = card.appealTypedData(model, review, 'The report includes the benchmark in section 3.');
  assert.equal(eip712(typed), '0x998a9d06ffe125ab4629f6a4ff8abc33be5501977db88f804dddcf1b6f5061a0');
  assert.throws(() => card.appealTypedData(model, review, 'Too short.'));
});

test('only the pending solver may appeal, inside the window, and other bounties fail closed', () => {
  const model = card.cardReview(publicState(), BOUNTY, 'base-sepolia');
  assert.equal(card.appealable(model, SOLVER, 1_949_999_999).round, 2);
  assert.equal(card.appealable(model, SOLVER, 1_950_000_000), null);
  assert.equal(card.appealable(model, '0x' + '44'.repeat(20), 1_900_000_000), null);
  for (const bad of [
    { bounty_contract: '0x' + 'cd'.repeat(20) },
    { network: 'base-mainnet' },
    { reviews: [{ ...publicState().reviews[0], document: { ...publicState().reviews[0].document, bounty_contract: '0x' + 'cd'.repeat(20) } }] },
    { reviews: [{ ...publicState().reviews[0], appeal: { status: 'granted', window_ends_at: 1 } }] },
    { deposit_payout: { status: 'paid', amount_micro_usdc: 1_000_000, solver: SOLVER, tx_hash: null } },
  ]) assert.throws(() => card.cardReview(publicState(bad), BOUNTY, 'base-sepolia'));
  // Before publication no fixed decision period is promised: a late publication leaves less time.
  const unpublished = card.cardReview(publicState({ pending_submission: { ...publicState().pending_submission, evidence: null } }), BOUNTY, 'base-sepolia');
  assert.match(card.summary(unpublished), /starts when the delivery's evidence is published and must end before the submission's on-chain deadline/);
  assert.doesNotMatch(card.summary(unpublished), /3-day/);
  // Silence accepts only when the API says so; an older response promises nothing.
  assert.doesNotMatch(card.summary(model), /automatic/);
  const scheduled = (auto) => card.cardReview(publicState({ pending_submission: { ...publicState().pending_submission,
    auto_accept: auto, sign_by: 1_999_996_400 } }), BOUNTY, 'base-sepolia');
  assert.match(card.summary(scheduled(true)), /If they don't decide by then, it is accepted automatically\.$/);
  assert.match(card.summary(scheduled(false)), /published too late for automatic acceptance: .*nothing is accepted/);
  assert.doesNotMatch(card.summary(scheduled(false)), /it is accepted automatically/);
  for (const bad of [{ auto_accept: true }, { sign_by: 1_999_996_400 }, { auto_accept: 'yes', sign_by: 1_999_996_400 },
    { auto_accept: true, sign_by: 1_899_999_999 }, { auto_accept: true, sign_by: 2_000_000_000 }]) {
    assert.throws(() => card.cardReview(publicState({ pending_submission: { ...publicState().pending_submission, ...bad } }), BOUNTY, 'base-sepolia'));
  }
  const reversed = card.cardReview(publicState({
    pending_submission: null, bounty_status: 'paid',
    reviews: [{ ...publicState().reviews[0], appeal: { status: 'reversed', window_ends_at: 1_950_000_000 },
      ruling: { document: { passed: true, reason: 'Section 3 contains the benchmark.' } } }],
    deposit_payout: { status: 'paid', amount_micro_usdc: 1_000_000, solver: SOLVER, tx_hash: word('a1') } }), BOUNTY, 'base-sepolia');
  assert.match(card.roundText(reversed.reviews[0], reversed), /reversed: Section 3 contains the benchmark\. The bounty settled and paid the solver\. The customer's review deposit \(1 USDC\) was sent to the solver; the transfer is verified on chain\./);
  // A ruling is not payment: until a confirmed BountySettled, nothing reads as paid or transferred.
  const ruled = { ...reversed, status: 'submitted', payout: { ...reversed.payout, status: 'owed', tx_hash: null } };
  const pendingText = card.roundText(reversed.reviews[0], ruled);
  assert.match(pendingText, /The solver is paid when the bounty settles on chain\. The customer's review deposit \(1 USDC\) is owed to the solver\./);
  assert.doesNotMatch(pendingText, /settled and paid|sent/);
  for (const status of ['upheld', undefined]) {
    const text = card.roundText({ ...reversed.reviews[0], appeal: status && { status, window_ends_at: 1 } }, ruled);
    assert.match(text, /Once the signed rejection is confirmed on chain, the solver's bond goes to the verifier/);
    assert.doesNotMatch(text, /went to|reopened/);
  }
});
