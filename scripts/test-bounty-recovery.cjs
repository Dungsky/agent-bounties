"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const scope = { window: {}, TextEncoder, crypto: require("node:crypto").webcrypto };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../site/evm.js"), "utf8"), scope);
const evm = scope.window.AgentBountiesEvm;
const core = require("../site/bounty-recovery.js")(evm);
const OWNER = "0x" + "1".repeat(40), OTHER = "0x" + "2".repeat(40), BOUNTY = "0x" + "3".repeat(40);
const ID = "0x" + "4".repeat(64), TX = "0x" + "5".repeat(64), BLOCK = "0x" + "6".repeat(64);
const word = n => "0x" + evm.uint256Word(n), addr = a => "0x" + evm.addressWord(a);
function fixture() {
  const data = new Map(), held = new Set();
  const storage = { getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const locks = { request: async (name, _options, fn) => { if (held.has(name)) return fn(null); held.add(name); try { return await fn({ name }); } finally { held.delete(name); } } };
  const f = { state: 1, contribution: 17068098n, funded: 17068098n, chain: core.CHAIN, walletChain: core.CHAIN, account: OWNER, code: core.CODE, canonical: 1n, receipt: null, safe: "0x64", calls: [], sends: [], stored: data, storage, locks, estimated: 0 };
  f.rpc = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "eth_chainId") return f.chain;
    if (method === "eth_getBlockByNumber") return { number: params[0] === "safe" || params[0] === "latest" ? f.safe : params[0], hash: f.blockHash || BLOCK };
    if (method === "eth_getCode") return f.code;
    if (method === "eth_estimateGas") { f.estimated++; if (f.simulationFailure) throw new Error("simulation failed"); return "0x122be"; }
    if (method === "eth_getTransactionReceipt") return f.receipt;
    if (method === "eth_getTransactionByHash") return f.transaction;
    if (method === "eth_call") {
      const signature = params[0].data.slice(0, 10);
      const values = { "factory()": addr(core.FACTORY), "settlementToken()": addr(core.TOKEN), "creator()": addr(OWNER), "bountyId()": ID, "status()": word(f.latestState !== undefined && params[1] === f.safe && f.planned ? f.latestState : f.state), "fundedAmount()": word(f.funded), "timeoutBondPool()": word(0), "isCanonicalBounty(address)": word(f.canonical), "contributions(address)": word(f.contribution) };
      for (const [name, value] of Object.entries(values)) if (core.selector(name) === signature) return value;
      throw new Error("Unexpected chain read " + signature);
    }
    throw new Error("Unexpected RPC " + method);
  };
  f.plan = async (action, contract, account) => { f.planned = true; return { from: account, to: contract, value_wei: 0, data: core.selector(action === "cancel" ? "cancel()" : "withdrawRefund()"), ...f.badPlan }; };
  f.provider = { request: async ({ method, params }) => {
    if (method === "eth_chainId") return f.walletChain;
    if (method === "eth_accounts") return [f.account];
    if (method === "eth_sendTransaction") {
      f.sends.push(params[0]);
      assert.ok([...data.values()].some(value => JSON.parse(value).txHash === null), "Persist before invoking wallet");
      if (f.sendError) throw f.sendError;
      if (f.waitSend) await f.waitSend;
      f.transaction = { hash: TX, ...params[0], input: params[0].data };
      return TX;
    }
    throw new Error("Unexpected wallet method " + method);
  } };
  f.engine = () => core.create(f);
  f.request = (engine = f.engine(), action = "cancel", account = OWNER) => engine.request({ contract: BOUNTY, account, action, provider: f.provider });
  f.confirm = (action = "cancel", overrides = {}) => {
    const refund = action === "refund";
    f.receipt = { transactionHash: TX, blockNumber: "0x64", blockHash: BLOCK, status: "0x1", logs: [{ address: BOUNTY, topics: [core.topic(refund ? "RefundWithdrawn(bytes32,address,uint256,uint256,uint256)" : "BountyCancelled(bytes32,uint256)"), ID, ...(refund ? [addr(OWNER)] : [])], data: refund ? "0x" + evm.uint256Word(17068098n) + evm.uint256Word(0) + evm.uint256Word(17068098n) : word(0) }], ...overrides };
    f.state = 5;
    if (refund) { f.contribution = 0n; f.funded = 0n; }
  };
  return f;
}
test("an already connected wallet does not receive another connection prompt", async () => {
  const calls = [], provider = { request: async ({ method }) => { calls.push(method); return [OWNER]; } };
  assert.equal(await core.connectWallet(provider), OWNER);
  assert.deepEqual(calls, ["eth_accounts"]);
});
test("a stalled wallet read times out before any prompt, plan or send", async () => {
  const f = fixture(); f.walletReadTimeoutMs = 5;
  f.provider.request = () => new Promise(() => {});
  await assert.rejects(f.request(), /wallet did not answer/);
  assert.equal(f.planned, undefined); assert.equal(f.sends.length, 0); assert.equal(f.stored.size, 0);
  assert.throws(() => core.walletRead(f.provider, "eth_sendTransaction"), /Only wallet connection reads/);
});
test("connection timeout and concurrent retry never duplicate the wallet prompt", async () => {
  let resolve, prompts = 0, connected = false;
  const provider = { request: ({ method }) => {
    if (method === "eth_accounts") return Promise.resolve(connected ? [OWNER] : []);
    assert.equal(method, "eth_requestAccounts"); prompts++;
    return new Promise(done => { resolve = done; });
  } };
  await assert.rejects(core.connectWallet(provider, 5), /finish its connection request/);
  const next = core.connectWallet(provider, 100), concurrent = core.connectWallet(provider, 100);
  await new Promise(done => setImmediate(done)); connected = true; resolve([OWNER]);
  assert.deepEqual(await Promise.all([next, concurrent]), [OWNER, OWNER]); assert.equal(prompts, 1);
  assert.equal(await core.connectWallet(provider), OWNER); assert.equal(prompts, 1);
});
test("rejected and malformed account connections cannot become a connected wallet", async () => {
  for (const accounts of [null, {}, [], ["invalid"]]) {
    const provider = { request: async ({ method }) => method === "eth_accounts" ? [] : accounts };
    await assert.rejects(core.connectWallet(provider));
  }
  let reject = true, prompts = 0;
  const provider = { request: async ({ method }) => {
    if (method === "eth_accounts") return [];
    prompts++; if (reject) throw Object.assign(new Error("rejected"), { code: 4001 }); return [OWNER];
  } };
  await assert.rejects(core.connectWallet(provider), { code: 4001 }); reject = false;
  assert.equal(await core.connectWallet(provider), OWNER); assert.equal(prompts, 2);
});
test("a stalled network switch times out and reuses the same prompt on retry", async () => {
  let finish, calls = 0;
  const provider = { request: ({ method, params }) => {
    calls++; assert.equal(method, "wallet_switchEthereumChain"); assert.deepEqual(params, [{ chainId: core.CHAIN }]);
    return new Promise(resolve => { finish = resolve; });
  } };
  await assert.rejects(core.switchToBase(provider, 5), /switching to Base/);
  const retry = core.switchToBase(provider, 100); finish(null); await retry; assert.equal(calls, 1);
});
test("read-only preparation never requests a signature", async () => {
  const f = fixture(), view = await f.engine().snapshot(BOUNTY, OWNER);
  assert.equal(view.funded, "17068098"); assert.equal(f.sends.length, 0);
  assert.ok(f.calls.filter(x => x.method === "eth_call").every(x => x.params[1] === "0x64"));
});
test("cancel, wait for safe event, then separately refund to the original contributor", async () => {
  const f = fixture(), engine = f.engine();
  await f.request(engine);
  assert.deepEqual(f.sends[0], { from: OWNER, to: BOUNTY, value: "0x0", data: "0xea8a1af0", chainId: "0x2105" });
  assert.equal((await engine.reconcile(BOUNTY, OWNER)).status, "pending");
  await assert.rejects(f.request(engine), /previous wallet request/);
  f.confirm(); f.receipt.blockNumber = "0x65";
  assert.equal((await engine.reconcile(BOUNTY, OWNER)).status, "pending");
  f.safe = "0x65";
  assert.equal((await engine.reconcile(BOUNTY, OWNER)).action, "cancel");
  await f.request(engine, "refund");
  assert.equal(f.sends[1].data, core.selector("withdrawRefund()"));
  f.confirm("refund");
  const result = await engine.reconcile(BOUNTY, OWNER);
  assert.equal(result.status, "confirmed"); assert.equal(result.amount, "17068098");
  await assert.rejects(f.request(engine, "refund"), /remaining contribution/);
  assert.equal(f.sends.length, 2);
});
for (const state of [2, 3, 4, 5]) test(`state ${state} cannot be cancelled`, async () => {
  const f = fixture(); f.state = state;
  await assert.rejects(f.request(), /cannot be cancelled/); assert.equal(f.sends.length, 0);
});
test("wrong owner, chain, counterfeit clone and noncanonical contract fail closed", async () => {
  for (const change of [{ account: OTHER }, { walletChain: "0x1" }, { chain: "0x1" }, { code: "0x1234" }, { canonical: 0n }]) {
    const f = Object.assign(fixture(), change); await assert.rejects(f.request()); assert.equal(f.sends.length, 0);
  }
  const f = fixture(); f.account = OTHER;
  await assert.rejects(f.request(f.engine(), "cancel", OTHER), /created this bounty/);
});
test("malicious plan cannot change recipient, sender, value or function", async () => {
  for (const badPlan of [{ to: OTHER }, { from: OTHER }, { value_wei: 1 }, { data: core.selector("claim()") }]) {
    const f = fixture(); f.badPlan = badPlan;
    await assert.rejects(f.request(), /does not match/); assert.equal(f.sends.length, 0);
  }
});
test("fresh state and simulation are checked before opening wallet", async () => {
  const f = fixture(); f.latestState = 2;
  await assert.rejects(f.request(), /cannot be cancelled/); assert.equal(f.sends.length, 0);
  const g = fixture(); g.simulationFailure = true;
  await assert.rejects(g.request(), /simulation failed/); assert.equal(g.sends.length, 0);
});
test("lost wallet response survives reload and prevents repeat requests", async () => {
  const f = fixture(); f.sendError = new Error("connection lost");
  await assert.rejects(f.request(), /connection lost/);
  const reloaded = f.engine(); assert.equal((await reloaded.reconcile(BOUNTY, OWNER)).status, "unknown");
  await assert.rejects(f.request(reloaded), /previous wallet request/); assert.equal(f.sends.length, 1);
});
test("explicit wallet rejection permits a new reviewed request", async () => {
  const f = fixture(); f.sendError = Object.assign(new Error("rejected"), { code: 4001 });
  await assert.rejects(f.request(), /rejected/); assert.equal(f.engine().saved(BOUNTY, OWNER), null);
});
test("storage failure and concurrent tabs cannot open a second wallet request", async () => {
  const f = fixture(); f.storage.setItem = () => { throw new Error("storage blocked"); };
  await assert.rejects(f.request(), /storage blocked/); assert.equal(f.sends.length, 0);
  const g = fixture(); let release; g.waitSend = new Promise(resolve => { release = resolve; });
  const first = g.request();
  await assert.rejects(g.request(), /another tab/);
  release(); await first; assert.equal(g.sends.length, 1);
});
test("reorgs, missing events, wrong refund recipients and mismatched transactions never confirm", async () => {
  const f = fixture(), e = f.engine(); await f.request(e); f.confirm();
  f.blockHash = "0x" + "7".repeat(64); assert.equal((await e.reconcile(BOUNTY, OWNER)).status, "pending");
  f.blockHash = BLOCK; f.receipt.logs = []; await assert.rejects(e.reconcile(BOUNTY, OWNER), /event is missing/);
  f.confirm(); f.transaction.to = OTHER; await assert.rejects(e.reconcile(BOUNTY, OWNER), /does not match/);
  const g = fixture(), e2 = g.engine(); g.state = 5; await g.request(e2, "refund"); g.confirm("refund");
  g.receipt.logs[0].topics[2] = addr(OTHER); await assert.rejects(e2.reconcile(BOUNTY, OWNER), /does not belong/);
});
test("a safely confirmed revert permits a retry without claiming completion", async () => {
  const f = fixture(), e = f.engine(); await f.request(e); f.confirm("cancel", { status: "0x0", logs: [] });
  assert.equal((await e.reconcile(BOUNTY, OWNER)).status, "failed"); assert.equal(e.saved(BOUNTY, OWNER), null);
});

test("RPC retries rate limits once on the pinned fallback and serializes reads", async () => {
  const calls = []; let active = 0;
  const rpc = core.createRpc(async (url, init) => {
    assert.equal(++active, 1); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    const body = JSON.parse(init.body); calls.push(url);
    return url.includes("publicnode") ? { status: 429 } : { status: 200, ok: true, json: async () => ({ ...body, result: core.CHAIN }) };
  });
  assert.deepEqual(await Promise.all([rpc("eth_chainId", []), rpc("eth_chainId", [])]), [core.CHAIN, core.CHAIN]);
  assert.deepEqual(calls, ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://mainnet.base.org"]);
  await assert.rejects(rpc("eth_sendTransaction", []), /only supports reads/);
  assert.equal(calls.length, 3);
});
test("RPC never retries a simulation revert or invalid response", async () => {
  for (const result of [{ error: { code: 3, message: "execution reverted" } }, { id: 999, result: "0x1" }]) {
    let calls = 0;
    const rpc = core.createRpc(async (_, init) => { calls++; return { status: 200, ok: true, json: async () => ({ ...JSON.parse(init.body), ...result }) }; });
    await assert.rejects(rpc("eth_estimateGas", []), /could not verify/); assert.equal(calls, 1);
  }
});
test("RPC unavailability is bounded and snapshot rejects a changed block", async () => {
  let calls = 0;
  const rpc = core.createRpc(async () => { calls++; throw new Error("offline"); });
  await assert.rejects(rpc("eth_chainId", []), /busy or unavailable/); assert.equal(calls, 2);
  const f = fixture(); const read = f.rpc;
  f.rpc = async (method, params) => method === "eth_getBlockByNumber" && params[0] === "0x64" ? { number: "0x64", hash: ID } : read(method, params);
  await assert.rejects(f.engine().snapshot(BOUNTY, OWNER), /block changed/);
});
test("restricted receipt history falls back without repeating a wallet request", async () => {
  for (const status of [401, 403]) {
    const calls = [];
    const rpc = core.createRpc(async (url, init) => {
      const body = JSON.parse(init.body); calls.push([url, body.method]);
      return url.includes("publicnode") ? { status } : { status: 200, ok: true, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { status: "0x1" } }) };
    });
    assert.deepEqual(await rpc("eth_getTransactionReceipt", [TX]), { status: "0x1" });
    assert.equal(calls.length, 2); assert.ok(calls.every(x => x[1] === "eth_getTransactionReceipt"));
  }
});
test("an old receipt cannot erase a newer pending wallet request", async () => {
  const f = fixture(), e = f.engine(); await f.request(e); f.confirm();
  const key = [...f.stored.keys()][0], read = f.rpc;
  let newer;
  f.rpc = async (method, params) => {
    if (method === "eth_getTransactionByHash") {
      newer = JSON.stringify({ ...JSON.parse(f.stored.get(key)), action: "refund", txHash: null });
      f.stored.set(key, newer);
    }
    return read(method, params);
  };
  await f.engine().reconcile(BOUNTY, OWNER);
  assert.equal(f.stored.get(key), newer);
});
test("wallet approval progress begins only after the exact request is saved", async () => {
  const f = fixture(), stages = [];
  await f.engine().request({ contract: BOUNTY, account: OWNER, action: "cancel", provider: f.provider, onProgress: stage => {
    stages.push(stage);
    if (stage === "wallet_approval") assert.ok([...f.stored.values()].some(x => JSON.parse(x).txHash === null));
  } });
  assert.deepEqual(stages, ["wallet_check", "bounty_check", "wallet_approval"]); assert.equal(f.sends.length, 1);
});

async function pageFixture(change = () => {}, expiry = false) {
  const f = expiry ? expiryFixture() : fixture(), nodes = new Map(), events = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", hidden: false, disabled: false, addEventListener: (type, fn) => events.set(`${id}:${type}`, fn) });
    return nodes.get(id);
  };
  change(f);
  const pageCore = { ...core, create: () => f.engine(), connectWallet: provider => core.connectWallet(provider, 10, 5), walletRead: (provider, method) => core.walletRead(provider, method, 5) };
  const timers = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../site/bounty-recovery-page.js"), "utf8"), {
    window: { AgentBountiesRecovery: pageCore, AgentBountiesWalletLink: { select: async options => { assert.equal(options.purpose, expiry ? "claim-expiry" : "recovery"); return { label: "MetaMask", kind: "browser", provider: f.provider }; } } },
    document: { getElementById: node }, localStorage: f.storage, navigator: { locks: f.locks },
    location: { search: `?bountyContract=${BOUNTY}${expiry ? "&network=base-mainnet&action=expire_claim&round=3" : ""}` }, URLSearchParams, AbortSignal,
    fetch: () => { throw new Error("No network in page fixture"); },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.push(t); return t; }, clearTimeout,
  });
  for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done));
  return { f, node, click: id => events.get(`recovery-${id}:click`)({ isTrusted: true }), close: () => timers.forEach(clearTimeout) };
}
test("recovery page connects the already-authorized extension and shows its balance", async () => {
  const p = await pageFixture(); await p.click("connect");
  assert.equal(p.node("recovery-wallet").textContent, OWNER);
  assert.equal(p.node("recovery-send").disabled, false); assert.equal(p.f.sends.length, 0);
  p.close();
});
test("stalled connection unlocks the UI and gives an actionable error", async () => {
  const p = await pageFixture(f => { f.provider.request = () => new Promise(() => {}); });
  await p.click("connect");
  assert.match(p.node("recovery-status").textContent, /Open and unlock/);
  assert.equal(p.node("recovery-connect").disabled, false);
  assert.equal(p.node("recovery-refresh").disabled, false);
  assert.equal(p.node("recovery-send").disabled, true); assert.equal(p.f.sends.length, 0); p.close();
});
test("an existing MetaMask connection prompt explains where to finish it", async () => {
  const p = await pageFixture(f => { f.provider.request = async ({ method }) => {
    if (method === "eth_accounts") return [];
    throw Object.assign(new Error("Already pending"), { code: -32002 });
  }; });
  await p.click("connect"); assert.match(p.node("recovery-status").textContent, /already open in your wallet/);
  assert.equal(p.node("recovery-connect").disabled, false); assert.equal(p.node("recovery-send").disabled, true); p.close();
});
test("check status stays available during wallet approval without another send", async () => {
  let finish;
  const p = await pageFixture(f => { f.waitSend = new Promise(resolve => { finish = resolve; }); });
  await p.click("connect"); const sending = p.click("send"); await new Promise(done => setImmediate(done));
  assert.match(p.node("recovery-status").textContent, /Open your wallet to confirm/);
  assert.equal(p.node("recovery-refresh").disabled, false); assert.equal(p.node("recovery-send").disabled, true);
  await p.click("refresh"); assert.match(p.node("recovery-status").textContent, /Do not send it again/);
  assert.equal(p.f.sends.length, 1); finish(); await sending; p.close();
});
for (const failRead of [false, true]) test(`a stale status ${failRead ? "error" : "result"} cannot overwrite an explicit wallet rejection`, async () => {
  let rejectSend, finishRead;
  const waitRead = new Promise(resolve => { finishRead = resolve; });
  const p = await pageFixture(f => {
    f.waitSend = new Promise((_, reject) => { rejectSend = reject; });
    const rpc = f.rpc;
    f.rpc = async (method, params) => {
      if (f.pauseRead && method === "eth_chainId") {
        await waitRead;
        if (failRead) throw new Error("Stale RPC failure");
      }
      return rpc(method, params);
    };
  });
  await p.click("connect");
  const sending = p.click("send"); await new Promise(done => setImmediate(done));
  p.f.pauseRead = true;
  const checking = p.click("refresh"); await new Promise(done => setImmediate(done));
  rejectSend(Object.assign(new Error("User rejected"), { code: 4001 })); await sending;
  assert.match(p.node("recovery-status").textContent, /wallet request did not finish/);
  finishRead(); await checking;
  assert.match(p.node("recovery-status").textContent, /wallet request did not finish/);
  assert.equal(p.node("recovery-send").disabled, false);
  assert.equal(p.f.stored.size, 0); assert.equal(p.f.sends.length, 1); p.close();
});

if (process.env.RECOVERY_BROWSER_TEST === "1") test("real browser: review, reload pending cancellation, refund, mobile layout", async () => {
  const http = require("node:http");
  const { chromium } = require("playwright");
  const site = path.resolve(__dirname, "../site");
  const server = http.createServer((req, res) => {
    const filename = path.resolve(site, "." + new URL(req.url, "http://localhost").pathname);
    if (!filename.startsWith(site + path.sep)) return res.writeHead(403).end();
    try { const content = fs.readFileSync(filename); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(filename)] || "application/octet-stream" }).end(content); }
    catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [390, 1280]) {
      const f = fixture(), errors = [];
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (["https://mainnet.base.org", "https://base-rpc.publicnode.com"].includes(url.origin)) {
          if (url.origin === "https://base-rpc.publicnode.com") return route.fulfill({ status: 429, body: "busy" });
          const body = route.request().postDataJSON();
          return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: await f.rpc(body.method, body.params) } });
        }
        if (url.pathname.endsWith("cancel-plan") || url.pathname.endsWith("refund-withdrawal-plan")) {
          const body = route.request().postDataJSON();
          return route.fulfill({ json: await f.plan(url.pathname.endsWith("cancel-plan") ? "cancel" : "refund", body.bounty_contract, body.caller) });
        }
        if (url.origin !== origin) return route.abort();
        return route.continue();
      });
      await context.exposeBinding("recoveryWalletFixture", async (_, { method, params }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
        if (method === "eth_chainId") return core.CHAIN;
        assert.equal(method, "eth_sendTransaction");
        f.sends.push(params[0]); f.transaction = { hash: TX, ...params[0], input: params[0].data };
        return TX;
      });
      await context.addInitScript(() => {
        window.ethereum = { isMetaMask: true, on: () => {}, request: args => window.recoveryWalletFixture(args) };
        const provider = { isMetaMask: true, on: () => {}, request: args => window.recoveryWalletFixture(args) };
        const brave = { isBraveWallet: true, isMetaMask: true, request: () => { throw new Error("Wrong wallet selected"); } };
        window.addEventListener("eip6963:requestProvider", () => {
          for (const detail of [
            { provider, info: { name: "MetaMask", rdns: "io.metamask", uuid: "11111111-1111-4111-8111-111111111111" } },
            { provider: brave, info: { name: "Brave Wallet", rdns: "com.brave.wallet", uuid: "22222222-2222-4222-8222-222222222222" } },
          ]) window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
        });
      });
      const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/recover-bounty.html?bountyContract=${BOUNTY}&analytics=off`);
      await page.getByRole("button", { name: "Connect my wallet", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: /MetaMask in this browser/ }).count(), 1);
      assert.equal(await page.getByRole("button", { name: /Brave Wallet in this browser/ }).count(), 1);
      assert.equal(await page.getByRole("dialog").getByText(/Buy USDC/).count(), 0);
      if (process.env.RECOVERY_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.RECOVERY_SCREENSHOT_DIR, `wallet-picker-${width}.png`) });
      await page.getByRole("button", { name: /MetaMask/ }).click();
      await page.getByText("Ready to cancel.", { exact: false }).waitFor();
      assert.equal(f.sends.length, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.RECOVERY_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.RECOVERY_SCREENSHOT_DIR, `recovery-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Cancel old bounty", exact: true }).click();
      await page.getByText("Your transaction was sent.", { exact: false }).waitFor();
      assert.equal(f.sends.length, 1);
      await page.reload();
      await page.getByRole("button", { name: "Connect my wallet", exact: true }).click();
      await page.getByRole("button", { name: /MetaMask/ }).click();
      await page.getByText("Your transaction was sent.", { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Cancel old bounty", exact: true }).isEnabled(), false);
      assert.equal(f.sends.length, 1);
      f.confirm();
      await page.getByRole("button", { name: "Check status", exact: true }).click();
      await page.getByText("Cancellation confirmed. Choose Return my funds", { exact: false }).waitFor();
      f.receipt = null;
      await page.getByRole("button", { name: "Return my funds", exact: true }).click();
      await page.getByText("Your transaction was sent.", { exact: false }).waitFor();
      f.confirm("refund");
      await page.getByRole("button", { name: "Check status", exact: true }).click();
      await page.getByText("17.068098 USDC returned", { exact: false }).waitFor();
      assert.equal(f.sends.length, 2); assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

// Synthetic bytecode is mapped only for these two reviewed hash pins. All ABI,
// selectors, event hashing, and receipt validation use the real EVM helper.
function expiryFixture() {
  const f = fixture();
  const localCore = require('../site/bounty-recovery.js')({ ...evm, keccak256Hex: code => code === '0x6001'
    ? '0x06f810de7b46f854ecc29e9c0c28156edab4b0d3e0bbe2bf5be8876687bebfc6'
    : code === '0x6002' ? '0xc36fcba5176b2cd8b57a9fd0cbf931177dc8b36cf8367c1568ccebe5f03be3f6' : evm.keccak256Hex(code) });
  Object.assign(f, { now: () => 1000000, state: 2, round: 3, deadline: 900, fundingDeadline: 950, bond: 1000000n, pool: 2000000n, reads: [], sessions: [] });
  f.plan = async (action, contract, account) => ({ from: account, to: contract, function: 'expireClaim()', data: core.selector('expireClaim()'), value_wei: 0, ...f.badPlan });
  f.expiryRpc = { session(limit) {
    const session = []; f.sessions.push(session);
    return async (index, method, params) => {
      const call = { index, method, params }; session.push(call); f.reads.push(call); assert.ok(session.length <= limit);
      if (f.override) { const result = f.override(call); if (result !== undefined) return result; }
      if (method === 'eth_chainId') return core.CHAIN;
      if (method === 'eth_getBlockByNumber') return { number: params[0] === 'safe' || params[0] === 'latest' ? '0x64' : params[0], hash: BLOCK, timestamp: '0x3e8' };
      if (method === 'eth_getCode') return params[0] === core.FACTORY ? '0x6001' : params[0] === core.IMPLEMENTATION ? '0x6002' : core.CODE;
      if (method === 'eth_getTransactionCount') return '0x1';
      if (method === 'eth_estimateGas') return '0x122be';
      if (method === 'eth_getTransactionReceipt') return f.receipt;
      if (method === 'eth_getTransactionByHash') return f.transaction;
      if (method === 'eth_call') {
        const signature = params[0].data.slice(0,10);
        const values = { 'implementation()': addr(core.IMPLEMENTATION), 'isCanonicalBounty(address)': word(1), 'factory()': addr(core.FACTORY), 'settlementToken()': addr(core.TOKEN), 'creator()': addr(OTHER), 'bountyId()': ID, 'termsHash()': '0x'+'7'.repeat(64), 'status()': word(f.state), 'round()': word(f.round), 'claimExpiresAt()': word(f.deadline), 'fundingDeadline()': word(f.fundingDeadline), 'solver()': addr(OTHER), 'activeClaimBond()': word(f.bond), 'timeoutBondPool()': word(f.pool), 'fundedAmount()': word(f.funded), 'expireClaim()': '0x' };
        for (const [name,value] of Object.entries(values)) if (core.selector(name) === signature) return value;
      }
      throw new Error('Unexpected expiry read '+method);
    };
  } };
  f.engine = () => localCore.create(f);
  f.review = e => e.expirySnapshot(BOUNTY,3);
  f.release = (e,reviewed) => e.requestExpiry({ contract: BOUNTY, account: OWNER, round: 3, reviewed, provider: f.provider });
  f.confirmExpiry = () => {
    f.transaction = { hash: TX, from: OWNER, to: BOUNTY, input: core.selector('expireClaim()'), value:'0x0', chainId:core.CHAIN, blockHash:BLOCK, blockNumber:'0x64', transactionIndex:'0x0' };
    f.receipt = { transactionHash:TX,from:OWNER,to:BOUNTY,blockHash:BLOCK,blockNumber:'0x64',transactionIndex:'0x0',status:'0x1',logs:[{address:BOUNTY,topics:[core.topic('ClaimExpired(bytes32,uint64,address,uint256,uint256)'),ID,word(3),addr(OTHER)],data:'0x'+evm.uint256Word(f.bond)+evm.uint256Word(f.pool+f.bond),removed:false,transactionHash:TX,blockHash:BLOCK,blockNumber:'0x64',transactionIndex:'0x0',logIndex:'0x0'}] };
  };
  return f;
}
test('expiry checks two readers within 56/64 calls, permits noncreator, and preserves passed funding deadline', async () => {
  const f=expiryFixture(), e=f.engine(), reviewed=await f.review(e);
  assert.equal(reviewed.creator,OTHER); assert.equal(f.sessions[0].length,56);
  assert.equal(reviewed.fundingDeadline,950);
  await f.release(e,reviewed);
  assert.equal(f.sessions[1].length,64); assert.equal(f.sends.length,1);
  assert.deepEqual(f.sends[0],{from:OWNER,to:BOUNTY,value:'0x0',data:core.selector('expireClaim()'),chainId:core.CHAIN});
  const simulations=f.sessions[1].filter(x=>x.method==='eth_call'&&x.params[0].data===core.selector('expireClaim()'));
  assert.equal(simulations.length,2); assert.ok(simulations.every(x=>x.params[1]==='pending'&&x.params[0].from===OWNER));
});
test('expiry rejects changed round, boundary, code, reader disagreement and pending nonce before wallet send', async () => {
  const cases=[f=>{f.round=4;}, f=>{f.deadline=1000;}, f=>{f.state=3;},
    f=>{f.override=x=>x.method==='eth_getCode'&&x.params[0]===core.IMPLEMENTATION?'0x6003':undefined;},
    f=>{f.override=x=>x.index===1&&x.method==='eth_getBlockByNumber'?{number:'0x64',hash:'0x'+'8'.repeat(64),timestamp:'0x3e8'}:undefined;},
    f=>{f.override=x=>x.method==='eth_getTransactionCount'&&x.params[1]==='pending'?'0x2':undefined;},
    f=>{f.override=x=>x.index===1&&x.method==='eth_getTransactionCount'?'0x2':undefined;},
    f=>{f.badPlan={function:'cancel()'};}, f=>{f.walletChain='0x1';}];
  for(const mutate of cases){const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e);mutate(f);await assert.rejects(f.release(e,reviewed));assert.equal(f.sends.length,0);assert.equal(f.stored.size,0);}
});
test('expiry changed pending state or review amount cannot be sent',async()=>{
  for(const mode of ['pending','bond']){const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e);
    if(mode==='pending')f.override=x=>x.method==='eth_call'&&x.params[1]==='pending'&&x.params[0].data===core.selector('status()')?word(3):undefined;else f.bond++;
    await assert.rejects(f.release(e,reviewed));assert.equal(f.sends.length,0);}
});
test('lost expiry wallet reply survives reload and never resends; explicit rejection before hash permits retry',async()=>{
  for(const rejected of [false,true]){const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e);f.sendError=Object.assign(new Error('lost or rejected'),rejected?{code:4001}:{});
    await assert.rejects(f.release(e,reviewed));assert.equal(f.sends.length,1);
    if(rejected)assert.equal(f.stored.size,0);else{assert.equal((await f.engine().reconcile(BOUNTY,OWNER)).status,'unknown');await assert.rejects(f.release(f.engine(),reviewed),/previous/);assert.equal(f.sends.length,1);}}
});
test('expiry pending poll reads only receipts and confirmation durably preserves exact bond evidence',async()=>{
  const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e);await f.release(e,reviewed);
  assert.equal((await e.reconcile(BOUNTY,OWNER)).status,'pending');assert.equal(f.sessions.at(-1).length,2);
  f.confirmExpiry();const result=await e.reconcile(BOUNTY,OWNER);
  assert.equal(result.status,'confirmed');assert.equal(result.bond,'1000000');assert.equal(result.pool,'3000000');assert.equal(e.saved(BOUNTY,OWNER),null);
  assert.ok([...f.stored.keys()].some(k=>k.endsWith(':confirmed')));assert.equal((await f.engine().reconcile(BOUNTY,OWNER)).status,'confirmed');assert.equal(f.sends.length,1);
});
test('expiry confirmation rejects wrong round, solver, bond, topic count, extra bytes, transaction and reader receipt mismatch',async()=>{
  const mutations=[f=>{f.receipt.logs[0].removed=true;},f=>{f.receipt.logs[0].topics[2]=word(4);},f=>{f.receipt.logs[0].topics[3]=addr(OWNER);},f=>{f.receipt.logs[0].data='0x'+evm.uint256Word(2)+evm.uint256Word(3000000);},f=>{f.receipt.logs[0].topics.push(ID);},f=>{f.receipt.logs[0].data+='00';},f=>{f.transaction.input=core.selector('cancel()');},f=>{f.override=x=>x.index===1&&x.method==='eth_getTransactionReceipt'?{...f.receipt,status:'0x0'}:undefined;}];
  for(const mutate of mutations){const f=expiryFixture(),e=f.engine();await f.release(e,await f.review(e));f.confirmExpiry();mutate(f);await assert.rejects(e.reconcile(BOUNTY,OWNER));assert.ok(e.saved(BOUNTY,OWNER));assert.equal(f.sends.length,1);}
});
test('expiry confirmation save failure retains pending fence',async()=>{
  const f=expiryFixture(),e=f.engine();await f.release(e,await f.review(e));f.confirmExpiry();const set=f.storage.setItem;f.storage.setItem=(k,v)=>{if(!k.endsWith(':confirmed'))set(k,v);};
  await assert.rejects(e.reconcile(BOUNTY,OWNER),/could not be saved/);assert.ok(e.saved(BOUNTY,OWNER));
});
test('expiry RPC does not retry rate limits and rejects unallowed calls before network',async()=>{
  let calls=0;const reader=core.createExpiryRpc(async()=>{calls++;return {ok:false};}).session();
  await assert.rejects(reader(0,'eth_chainId',[]),/unavailable/);await assert.rejects(reader(1,'eth_chainId',[]));assert.equal(calls,1);
  const forbidden=core.createExpiryRpc(async()=>{calls++;throw new Error('wire');}).session();await assert.rejects(forbidden(0,'eth_sendTransaction',[]));assert.equal(calls,1);
});
test('expiry round links require exact positive safe integer',()=>{for(const value of [null,'','0','-1','3.0','3e0','9007199254740992'])assert.throws(()=>core.expiryRound(value));assert.equal(core.expiryRound('3'),3);});
test('expiry page explains forfeiture and passed funding deadline, connects a noncreator without sending',async()=>{
 const p=await pageFixture(()=>{},true);await p.click('connect');assert.equal(p.node('recovery-send').disabled,false);assert.equal(p.node('recovery-title').textContent,'Release expired claim');assert.equal(p.node('recovery-contribution').textContent,'Not needed for claim release');assert.match(p.node('recovery-bond').textContent,/1(?:\.0+)? USDC.*not refunded or paid/);assert.match(p.node('recovery-deadline').textContent,/Neither date is extended/);assert.equal(p.f.sends.length,0);p.close();
});
test('expiry page polls receipt only after trusted click and never sends on refresh',async()=>{
 const p=await pageFixture(()=>{},true);await p.click('connect');await p.click('send');assert.equal(p.f.sends.length,1);assert.equal(p.node('recovery-send').disabled,true);assert.equal(p.f.sessions.at(-1).length,2);await p.click('refresh');assert.equal(p.f.sends.length,1);assert.equal(p.f.sessions.at(-1).length,2);p.f.confirmExpiry();await p.click('refresh');assert.match(p.node('recovery-status').textContent,/Claim 3 was released.*No deadline was extended/);assert.equal(p.node('recovery-send').disabled,true);p.close();
});
test('expiry page lost reply remains blocked after Check status',async()=>{
 const p=await pageFixture(f=>{f.sendError=new Error('connection lost');},true);await p.click('connect');await p.click('send');await p.click('refresh');assert.equal(p.f.sends.length,1);assert.equal(p.node('recovery-send').disabled,true);assert.match(p.node('recovery-status').textContent,/reply was lost.*stale wallet prompt/);p.close();
});
test('a confirmed expiry does not break the later normal cancellation page or claim a refund',async()=>{
 const source=expiryFixture(),e=source.engine();await source.release(e,await source.review(e));source.confirmExpiry();await e.reconcile(BOUNTY,OWNER);
 const p=await pageFixture(f=>{f.storage=source.storage;f.stored=source.stored;f.engine=()=>({snapshot:async()=>({contract:BOUNTY,creator:OWNER,state:1,funded:'17068098',contribution:'0'}),reconcile:()=>e.reconcile(BOUNTY,OWNER),saved:()=>null});});
 await p.click('connect');assert.match(p.node('recovery-status').textContent,/expired claim was released.*No refund or payment/);assert.equal(p.node('recovery-send').disabled,false);assert.equal(p.node('recovery-send').textContent,'Cancel old bounty');p.close();
});
test('expiry initial scan blocks connection and duplicate refresh until its reads finish',async()=>{
 let release,blocked=true;const wait=new Promise(done=>{release=done;});
 const p=await pageFixture(f=>{f.override=x=>{if(blocked&&x.method==='eth_chainId'){blocked=false;return wait.then(()=>core.CHAIN);}};},true);
 assert.equal(p.node('recovery-connect').disabled,true);await p.click('connect');await p.click('refresh');assert.equal(p.f.sessions.length,1);assert.equal(p.f.reads.length,1);
 release();for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));assert.equal(p.f.sessions.length,1);assert.equal(p.node('recovery-connect').disabled,false);p.close();
});
test('expiry receipt refresh is single flight and never amplifies pending polls',async()=>{
 const p=await pageFixture(()=>{},true);await p.click('connect');await p.click('send');let release,blocked=true;const wait=new Promise(done=>{release=done;});p.f.override=x=>{if(blocked&&x.method==='eth_getTransactionReceipt'){blocked=false;return wait.then(()=>null);}};
 const before=p.f.sessions.length,first=p.click('refresh');await new Promise(done=>setImmediate(done));await p.click('refresh');assert.equal(p.f.sessions.length,before+1);assert.equal(p.node('recovery-connect').disabled,true);release();await first;assert.equal(p.f.sessions.at(-1).length,2);assert.equal(p.f.sends.length,1);p.close();
});
test('expiry hash persistence error, including a misleading4001, never removes the durable unknown request',async()=>{
 for(const code of [undefined,4001]){const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e),set=f.storage.setItem;f.storage.setItem=(k,v)=>{if(JSON.parse(v).txHash)throw Object.assign(new Error('disk write failed'),{code});set(k,v);};await assert.rejects(f.release(e,reviewed));assert.equal(f.sends.length,1);assert.equal(f.engine().saved(BOUNTY,OWNER).txHash,null);await assert.rejects(f.release(f.engine(),reviewed),/previous/);assert.equal(f.sends.length,1);}
});
test('expiry parallel tabs cannot open a second wallet request',async()=>{
 const f=expiryFixture(),e=f.engine(),reviewed=await f.review(e);let release;f.waitSend=new Promise(done=>{release=done;});const first=f.release(e,reviewed);for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));await assert.rejects(f.release(f.engine(),reviewed),/previous/);release();await first;assert.equal(f.sends.length,1);
});
if (process.env.RECOVERY_BROWSER_TEST === '1') test('real browser: expiry picker, review, one request, reload and exact confirmation',async()=>{
 const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});
 const origin='http://127.0.0.1:48937',site=path.resolve(__dirname,'../site');
 try{for(const width of [390,1280]){
  const f=expiryFixture(),errors=[],context=await browser.newContext({viewport:{width,height:900}});
  // Actual transport and page code run; all traffic is intercepted locally.
  const read=f.expiryRpc.session(1000);
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(['https://mainnet.base.org','https://base.drpc.org'].includes(url.origin)){
    const body=route.request().postDataJSON();return route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:await read(url.origin==='https://mainnet.base.org'?0:1,body.method,body.params)}});
   }
   if(url.origin==='https://api.agentizable.ai'&&url.pathname.endsWith('/expire-claim-plan')){const body=route.request().postDataJSON();return route.fulfill({json:await f.plan('expire_claim',body.bounty_contract,body.caller)});}
   if(url.origin!==origin)return route.abort();
   const filename=path.resolve(site,'.'+url.pathname);if(!filename.startsWith(site+path.sep)||!fs.existsSync(filename))return route.fulfill({status:404,body:''});
   let body=fs.readFileSync(filename);if(url.pathname==='/evm.js')body=body.toString()+`\nwindow.AgentBountiesEvm={...window.AgentBountiesEvm,keccak256Hex:(original=>code=>code==='0x6001'?'0x06f810de7b46f854ecc29e9c0c28156edab4b0d3e0bbe2bf5be8876687bebfc6':code==='0x6002'?'0xc36fcba5176b2cd8b57a9fd0cbf931177dc8b36cf8367c1568ccebe5f03be3f6':original(code))(window.AgentBountiesEvm.keccak256Hex)};`;
   return route.fulfill({body,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(filename)]||'application/octet-stream'});
  });
  await context.exposeBinding('expiryWalletFixture',async(_,{method,params})=>{
   if(method==='eth_accounts'||method==='eth_requestAccounts')return[OWNER];if(method==='eth_chainId')return core.CHAIN;
   assert.equal(method,'eth_sendTransaction');f.sends.push(params[0]);return TX;
  });
  await context.addInitScript(()=>{Date.now=()=>1000000;window.ethereum={isMetaMask:true,on:()=>{},request:args=>window.expiryWalletFixture(args)};});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/recover-bounty.html?bountyContract=${BOUNTY}&network=base-mainnet&action=expire_claim&round=3&analytics=off`);
  await page.getByRole('button',{name:'Connect my wallet',exact:true}).click();
  assert.equal(await page.getByRole('dialog').getByText(/Buy USDC/).count(),0);
  await page.getByRole('button',{name:/MetaMask in this browser/}).click();
  await page.getByText(/Review claim 3/).waitFor();assert.equal(f.sends.length,0);assert.equal(await page.locator('#recovery-contribution').textContent(),'Not needed for claim release');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.RECOVERY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.RECOVERY_SCREENSHOT_DIR,`expiry-review-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'Release expired claim',exact:true}).click();
  await page.getByText(/Your expiry transaction was sent/).waitFor();assert.equal(f.sends.length,1);
  await page.reload();await page.getByRole('button',{name:'Connect my wallet',exact:true}).click();await page.getByRole('button',{name:/MetaMask in this browser/}).click();
  await page.getByText(/Your expiry transaction was sent/).waitFor();assert.equal(f.sends.length,1);assert.equal(await page.locator('#recovery-send').isEnabled(),false);
  f.confirmExpiry();await page.getByRole('button',{name:'Check status',exact:true}).click();await page.getByText(/Claim 3 was released/).waitFor();assert.equal(f.sends.length,1);assert.deepEqual(errors,[]);
  if(process.env.RECOVERY_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.RECOVERY_SCREENSHOT_DIR,`expiry-confirmed-${width}.png`),fullPage:true});
  await context.close();
 }}finally{await browser.close();}
});
test('expiry page never says no transaction was sent when hash persistence throws4001',async()=>{
 const p=await pageFixture(f=>{const set=f.storage.setItem;f.storage.setItem=(k,v)=>{if(JSON.parse(v).txHash)throw Object.assign(new Error('write failed after returned hash'),{code:4001});set(k,v);};},true);
 await p.click('connect');assert.match(p.node('recovery-bond').textContent,new RegExp('Claim 3, solver '+OTHER));await p.click('send');assert.equal(p.f.sends.length,1);assert.doesNotMatch(p.node('recovery-status').textContent,/No transaction was sent/i);assert.match(p.node('recovery-status').textContent,/Check status and wallet activity/);assert.equal(p.node('recovery-send').disabled,true);await p.click('refresh');assert.equal(p.f.sends.length,1);assert.match(p.node('recovery-status').textContent,/reply was lost/);p.close();
});
