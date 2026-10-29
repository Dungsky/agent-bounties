/* Legacy autonomous-v1 recovery. Wallet confirmation is always required. */
"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.AgentBountiesRecovery = factory(root.AgentBountiesEvm);
})(typeof window === "object" ? window : globalThis, function createRecovery(evm) {
  const CHAIN = "0x2105";
  const FACTORY = "0x082c52131aaf0c56e76b075f895eab6fcab6d2f9";
  const IMPLEMENTATION = "0x2fa36d2b2327642db3a6cc8cdd91544ad7484eb9";
  const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const CODE = `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const address = value => {
    const result = String(value || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(result) || /^0x0{40}$/.test(result)) throw new Error("Invalid wallet or bounty address.");
    return result;
  };
  const hash = value => {
    if (!/^0x[0-9a-f]{64}$/i.test(String(value || ""))) throw new Error("Invalid transaction hash.");
    return value.toLowerCase();
  };
  const selector = name => evm.keccak256Hex(evm.textHex(name)).slice(0, 10);
  const topic = name => evm.keccak256Hex(evm.textHex(name));
  const uint = value => {
    if (!/^0x[0-9a-f]{64}$/i.test(String(value))) throw new Error("The chain returned an invalid value.");
    return BigInt(value);
  };
  const readAddress = value => {
    uint(value);
    if (!/^0x0{24}/i.test(value)) throw new Error("The chain returned an invalid address.");
    return address(`0x${value.slice(-40)}`);
  };
  const usdc = value => {
    const n = BigInt(value);
    return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`;
  };
  const connectionRequests = new WeakMap();
  async function waitForWallet(promise, timeoutMs, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "wallet_timeout" })), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function walletRead(provider, method, timeoutMs = 10000) {
    if (!["eth_accounts", "eth_chainId"].includes(method)) throw new Error("Only wallet connection reads are allowed here.");
    return waitForWallet(Promise.resolve().then(() => provider.request({ method })), timeoutMs,
      "Your wallet did not answer. Open and unlock it, then connect again. No transaction was requested.");
  }
  async function connectionRequest(provider, method, params, timeoutMs, message) {
    let requests = connectionRequests.get(provider);
    if (!requests) { requests = new Map(); connectionRequests.set(provider, requests); }
    let request = requests.get(method);
    if (!request) {
      request = Promise.resolve().then(() => provider.request({ method, ...(params ? { params } : {}) }));
      requests.set(method, request);
      const clear = () => { if (requests.get(method) === request) requests.delete(method); };
      request.then(clear, clear);
    }
    return waitForWallet(request, timeoutMs, message);
  }
  async function connectWallet(provider, timeoutMs = 60000, readTimeoutMs = 10000) {
    let accounts;
    try { accounts = await walletRead(provider, "eth_accounts", readTimeoutMs); }
    catch (error) { if (error.code !== 4100) throw error; accounts = []; }
    if (Array.isArray(accounts) && accounts.length) return address(accounts[0]);
    if (!Array.isArray(accounts)) throw new Error("Your wallet returned an invalid account list. Reconnect it.");
    accounts = await connectionRequest(provider, "eth_requestAccounts", null, timeoutMs,
      "Open your wallet and finish its connection request, then choose Connect my wallet again. No payment was requested.");
    if (!Array.isArray(accounts) || !accounts.length) throw new Error("No wallet account was selected. Unlock your wallet and connect again.");
    return address(accounts[0]);
  }
  function switchToBase(provider, timeoutMs = 60000) {
    return connectionRequest(provider, "wallet_switchEthereumChain", [{ chainId: CHAIN }], timeoutMs,
      "Finish switching to Base in your wallet, then choose Connect my wallet again. No payment was requested.");
  }
  // This transport can only read or simulate. Wallet writes never use retries.
  function createRpc(fetcher = fetch) {
    const endpoints = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
    const allowed = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_estimateGas", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
    let nextId = 0, tail = Promise.resolve(), preferred = 0;
    async function read(method, params) {
      if (!allowed.has(method)) throw new Error("Recovery RPC only supports reads and simulations.");
      const id = ++nextId, first = preferred;
      for (let attempt = 0; attempt < endpoints.length; attempt++) {
        const index = (first + attempt) % endpoints.length;
        let response;
        try {
          response = await fetcher(endpoints[index], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(12000) });
        } catch (_) { continue; }
        // Some public readers require a token for transaction history. Fall
        // back only for read/simulation transport; this cannot repeat a send.
        if ([401, 403, 429].includes(response.status) || response.status >= 500) continue;
        if (!response.ok) throw new Error("Base could not verify this request. Check status before trying again.");
        const result = await response.json();
        if (result.error?.code === -32005) continue;
        if (result.jsonrpc !== "2.0" || result.id !== id || result.error || !("result" in result)) throw new Error("Base could not verify this request. Check status before trying again.");
        preferred = index;
        return result.result;
      }
      throw new Error("Base is busy or unavailable. Check status shortly; no wallet request was repeated.");
    }
    return (method, params) => {
      const pending = tail.then(() => read(method, params));
      tail = pending.catch(() => {});
      return pending;
    };
  }
  // Expiry is restricted to the original reviewed deployment above. These
  // hashes include constructor immutables; no caller or API can replace them.
  const EXPIRY_CODE_HASHES = Object.freeze({
    [FACTORY]: "0x06f810de7b46f854ecc29e9c0c28156edab4b0d3e0bbe2bf5be8876687bebfc6",
    [IMPLEMENTATION]: "0xc36fcba5176b2cd8b57a9fd0cbf931177dc8b36cf8367c1568ccebe5f03be3f6",
  });
  function createExpiryRpc(fetcher = fetch, clock = () => performance.now()) {
    const endpoints = ["https://mainnet.base.org", "https://base.drpc.org"];
    const allowed = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
    return { session(maxCalls = 64) {
      const end = clock() + 60000;
      let count = 0, next = 0, halted = false, tail = Promise.resolve();
      async function read(index, method, params) {
        if (halted || ![0, 1].includes(index) || !allowed.has(method) || count >= maxCalls) throw new Error("Recovery read limit reached. No wallet request was sent.");
        let timer, controller;
        try {
          const delay = Math.max(0, next - clock());
          if (clock() + delay >= end) throw new Error("Recovery checks timed out. Check status before trying again.");
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          const remaining = end - clock();
          if (remaining <= 0) throw new Error("Recovery checks timed out. Check status before trying again.");
          const id = ++count;
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(), Math.min(4000, remaining));
          next = clock() + 100;
          const response = await fetcher(endpoints[index], { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal });
          if (!response.ok) throw new Error("A Base reader is unavailable. Stop and check status later; no request was repeated.");
          const stream = response.body?.getReader();
          if (!stream) throw new Error("A bounded Base response is unavailable.");
          const chunks = []; let length = 0;
          try {
            while (true) {
              const chunk = await stream.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > 1048576) throw new Error("Base returned an oversized response.");
              chunks.push(chunk.value);
            }
          } finally { stream.releaseLock(); }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          if (clock() >= end) throw new Error("Recovery checks timed out. Check status before trying again.");
          const result = JSON.parse(new TextDecoder().decode(bytes));
          if (result.jsonrpc !== "2.0" || result.id !== id || result.error || !("result" in result)) throw new Error("Base could not verify this request. No wallet request was repeated.");
          return result.result;
        } catch (error) { halted = true; controller?.abort(); throw error; }
        finally { clearTimeout(timer); }
      }
      return (index, method, params) => {
        const result = tail.then(() => read(index, method, params));
        tail = result.catch(() => {}); return result;
      };
    } };
  }
  function expiryRound(value) {
    if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error("Open an expiry link with the exact claim round.");
    return Number(value);
  }
  function create({ rpc, plan, storage, locks, now = () => Date.now(), walletReadTimeoutMs = 10000, expiryRpc = createExpiryRpc() }) {
    async function snapshot(contract, account, tag = "safe") {
      contract = address(contract); account = account ? address(account) : null;
      if (await rpc("eth_chainId", []) !== CHAIN) throw new Error("The chain service is not Base.");
      const block = await rpc("eth_getBlockByNumber", [tag, false]);
      if (!block || !/^0x[0-9a-f]+$/i.test(block.number) || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error("A confirmed Base block is unavailable.");
      const at = block.number;
      const call = (name, args = "", to = contract) => rpc("eth_call", [{ to, data: selector(name) + args }, at]);
      const [code, canonical, factory, token, creator, bountyId, status, funded, pool] = await Promise.all([
        rpc("eth_getCode", [contract, at]), call("isCanonicalBounty(address)", evm.addressWord(contract), FACTORY),
        call("factory()"), call("settlementToken()"), call("creator()"), call("bountyId()"),
        call("status()"), call("fundedAmount()"), call("timeoutBondPool()"),
      ]);
      if (code.toLowerCase() !== CODE || uint(canonical) !== 1n || readAddress(factory) !== FACTORY || readAddress(token) !== TOKEN) throw new Error("This is not a supported canonical bounty. No wallet request was sent.");
      const owner = readAddress(creator), state = Number(uint(status));
      if (state < 0 || state > 5) throw new Error("Unknown bounty state.");
      const contribution = account ? uint(await call("contributions(address)", evm.addressWord(account))) : 0n;
      const checkedBlock = await rpc("eth_getBlockByNumber", [at, false]);
      if (checkedBlock?.hash?.toLowerCase() !== block.hash.toLowerCase()) throw new Error("The Base block changed. Refresh before continuing.");
      return { contract, creator: owner, bountyId: hash(bountyId), state, funded: uint(funded).toString(), pool: uint(pool).toString(), contribution: contribution.toString(), block: at, blockHash: block.hash };
    }
    function blockIdentity(value, maxAge) {
      if (!value || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.number) || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.timestamp)) throw new Error("A valid Base block is unavailable.");
      const timestamp = Number(BigInt(value.timestamp)), age = Math.floor(now() / 1000) - timestamp;
      if (!Number.isSafeInteger(timestamp) || age < 0 || (maxAge !== null && age > maxAge)) throw new Error("Base returned an old or future block. Check status later.");
      return { number: value.number.toLowerCase(), hash: hash(value.hash), timestamp };
    }
    const sameBlock = (a, b) => a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
    function expiryEligible(view, round) {
      if (view.state !== 2 || view.round !== expiryRound(round)) throw new Error("This is no longer the reviewed active claim. Refresh its current round.");
      if (view.deadline <= 0 || view.timestamp <= view.deadline) throw new Error("The claim deadline has not passed on Base yet.");
      if (BigInt(view.bond) <= 0n) throw new Error("The claim bond could not be verified.");
    }
    async function expirySnapshot(contract, round, account = null, prepare = false) {
      contract = address(contract); round = expiryRound(round); account = account ? address(account) : null;
      if (prepare && !account) throw new Error("Connect the wallet that will request expiry.");
      const read = expiryRpc.session(64), heads = [], views = [];
      for (const i of [0, 1]) {
        if (await read(i, "eth_chainId", []) !== CHAIN) throw new Error("The reader is not on Base.");
        heads.push(blockIdentity(await read(i, "eth_getBlockByNumber", ["safe", false]), 600));
      }
      const at = BigInt(heads[0].number) < BigInt(heads[1].number) ? heads[0].number : heads[1].number;
      let common;
      for (const i of [0, 1]) {
        const block = blockIdentity(await read(i, "eth_getBlockByNumber", [at, false]), 600);
        if (block.number !== at || (heads[i].number === at && !sameBlock(heads[i], block)) || (common && !sameBlock(common, block))) throw new Error("Base readers disagree. Stop and check status later.");
        common = block;
        for (const target of [FACTORY, IMPLEMENTATION, contract]) {
          const code = await read(i, "eth_getCode", [target, at]);
          if (!/^0x(?:[0-9a-f]{2})+$/i.test(code) || (target === contract ? code.toLowerCase() !== CODE : evm.keccak256Hex(code) !== EXPIRY_CODE_HASHES[target])) throw new Error("This is not the supported original bounty code.");
        }
        const call = (name, tag = at, to = contract, args = "") => read(i, "eth_call", [{ to, data: selector(name) + args }, tag]);
        if (readAddress(await call("implementation()", at, FACTORY)) !== IMPLEMENTATION || uint(await call("isCanonicalBounty(address)", at, FACTORY, evm.addressWord(contract))) !== 1n) throw new Error("The bounty is not canonical.");
        const values = {};
        for (const name of ["factory", "settlementToken", "creator", "bountyId", "termsHash", "status", "round", "claimExpiresAt", "solver", "activeClaimBond", "timeoutBondPool", "fundedAmount", "fundingDeadline"]) values[name] = await call(`${name}()`);
        if (readAddress(values.factory) !== FACTORY || readAddress(values.settlementToken) !== TOKEN) throw new Error("The bounty's factory or token changed.");
        const view = { contract, creator: readAddress(values.creator), bountyId: hash(values.bountyId), termsHash: hash(values.termsHash), state: Number(uint(values.status)), round: Number(uint(values.round)), deadline: Number(uint(values.claimExpiresAt)), fundingDeadline: Number(uint(values.fundingDeadline)), solver: readAddress(values.solver), bond: uint(values.activeClaimBond).toString(), pool: uint(values.timeoutBondPool).toString(), funded: uint(values.fundedAmount).toString(), block: at, blockHash: block.hash, timestamp: block.timestamp };
        if (!Number.isSafeInteger(view.round) || !Number.isSafeInteger(view.deadline) || !Number.isSafeInteger(view.fundingDeadline)) throw new Error("The claim timing is invalid.");
        expiryEligible(view, round);
        const latest = blockIdentity(await read(i, "eth_getBlockByNumber", ["latest", false]), 90);
        if (BigInt(latest.number) < BigInt(at) || latest.timestamp < block.timestamp || latest.timestamp <= view.deadline) throw new Error("The latest Base state is unavailable.");
        for (const [name, expected] of [["status", values.status], ["round", values.round], ["claimExpiresAt", values.claimExpiresAt], ["solver", values.solver], ["activeClaimBond", values.activeClaimBond]]) {
          if ((await call(`${name}()`, "pending")).toLowerCase() !== expected.toLowerCase()) throw new Error("The claim changed before expiry. Refresh and review it again.");
        }
        if (prepare) {
          const nonces = [];
          for (const tag of ["latest", "pending"]) {
            const n = await read(i, "eth_getTransactionCount", [account, tag]);
            if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(n)) throw new Error("Your wallet's pending state is unavailable.");
            nonces.push(BigInt(n));
          }
          view.walletNonce = nonces[0].toString();
          if (nonces[0] !== nonces[1]) throw new Error("Your wallet has a pending transaction. Check wallet activity before requesting expiry.");
          const tx = { from: account, to: contract, value: "0x0", data: selector("expireClaim()") };
          if (await read(i, "eth_call", [tx, "pending"]) !== "0x") throw new Error("Base did not accept the expiry simulation. No wallet request was sent.");
          const estimate = await read(i, "eth_estimateGas", [tx, "pending"]);
          if (!/^0x[1-9a-f][0-9a-f]*$/i.test(estimate)) throw new Error("The expiry gas estimate is unavailable.");
        }
        if (!sameBlock(blockIdentity(await read(i, "eth_getBlockByNumber", [at, false]), 600), block)) throw new Error("The confirmed block changed. Check status again.");
        views.push(view);
      }
      if (JSON.stringify(views[0]) !== JSON.stringify(views[1])) throw new Error("Base readers disagree on this claim.");
      return views[0];
    }
    async function expiryReceipt(record) {
      const read = expiryRpc.session(24), receipts = [];
      // Light polling does only two receipt reads until both readers see a receipt.
      for (const i of [0, 1]) receipts.push(await read(i, "eth_getTransactionReceipt", [record.txHash]));
      if (!receipts[0] || !receipts[1]) return { status: "pending", txHash: record.txHash };
      const receiptIdentity = receipt => JSON.stringify({ status: receipt.status, transactionHash: receipt.transactionHash, from: receipt.from, to: receipt.to, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex, logs: (receipt.logs || []).map(log => ({ address: log.address, topics: log.topics, data: log.data, removed: Boolean(log.removed), transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: log.blockNumber, transactionIndex: log.transactionIndex, logIndex: log.logIndex })) });
      if (receiptIdentity(receipts[0]) !== receiptIdentity(receipts[1])) throw new Error("Base readers disagree on the receipt. Do not send again.");
      const receipt = receipts[0], heads = [], evidence = [];
      for (const i of [0, 1]) {
        if (await read(i, "eth_chainId", []) !== CHAIN) throw new Error("The reader is not on Base.");
        heads.push(blockIdentity(await read(i, "eth_getBlockByNumber", ["safe", false]), 600));
      }
      const at = BigInt(heads[0].number) < BigInt(heads[1].number) ? heads[0].number : heads[1].number;
      if (!/^0x[0-9a-f]+$/i.test(receipt.blockNumber) || BigInt(receipt.blockNumber) > BigInt(at)) return { status: "pending", txHash: record.txHash };
      for (const i of [0, 1]) {
        const tx = await read(i, "eth_getTransactionByHash", [record.txHash]);
        const safe = blockIdentity(await read(i, "eth_getBlockByNumber", [at, false]), 600);
        const block = blockIdentity(await read(i, "eth_getBlockByNumber", [receipt.blockNumber, false]), null);
        if (safe.number !== at || (heads[i].number === at && !sameBlock(heads[i], safe)) || block.number !== receipt.blockNumber.toLowerCase() || block.hash !== hash(receipt.blockHash) || BigInt(block.number) > BigInt(safe.number) || block.timestamp > safe.timestamp) throw new Error("The receipt is not confirmed on Base.");
        if (!tx || hash(tx.hash) !== record.txHash || hash(receipt.transactionHash) !== record.txHash || address(tx.from) !== record.account || address(receipt.from) !== record.account || address(tx.to) !== record.contract || address(receipt.to) !== record.contract || tx.input?.toLowerCase() !== selector("expireClaim()") || BigInt(tx.value) !== 0n || BigInt(tx.chainId) !== 8453n || hash(tx.blockHash) !== block.hash || tx.blockNumber?.toLowerCase() !== block.number || tx.transactionIndex?.toLowerCase() !== receipt.transactionIndex?.toLowerCase()) throw new Error("The receipt does not match the saved expiry request.");
        const code = await read(i, "eth_getCode", [record.contract, block.number]);
        const canonical = await read(i, "eth_call", [{ to: FACTORY, data: selector("isCanonicalBounty(address)") + evm.addressWord(record.contract) }, block.number]);
        if (String(code).toLowerCase() !== CODE || uint(canonical) !== 1n) throw new Error("The receipt is not from a supported canonical bounty.");
        let result;
        if (BigInt(receipt.status) === 0n) result = { status: "failed", txHash: record.txHash };
        else {
          if (BigInt(receipt.status) !== 1n || block.timestamp <= record.deadline) throw new Error("Invalid expiry result.");
          const matches = (receipt.logs || []).filter(log => log.address?.toLowerCase() === record.contract && log.topics?.[0]?.toLowerCase() === topic("ClaimExpired(bytes32,uint64,address,uint256,uint256)"));
          const log = matches[0];
          if (matches.length !== 1 || log.removed || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex) || log.topics.length !== 4 || !/^0x[0-9a-f]{128}$/i.test(log.data) || log.topics[1]?.toLowerCase() !== record.bountyId || log.topics[2]?.toLowerCase() !== `0x${BigInt(record.round).toString(16).padStart(64, "0")}` || log.topics[3]?.toLowerCase() !== `0x${evm.addressWord(record.solver)}` || hash(log.transactionHash) !== record.txHash || hash(log.blockHash) !== block.hash || log.blockNumber?.toLowerCase() !== block.number || log.transactionIndex?.toLowerCase() !== receipt.transactionIndex?.toLowerCase()) throw new Error("The exact reviewed claim expiry event is missing.");
          const bond = uint(`0x${log.data.slice(2, 66)}`).toString(), pool = uint(`0x${log.data.slice(66)}`).toString();
          if (bond !== record.bond || pool !== record.expectedPool) throw new Error("The bond outcome differs from the reviewed expiry.");
          result = { status: "confirmed", action: "expire_claim", txHash: record.txHash, bond, pool, round: record.round, blockHash: block.hash };
        }
        if (!sameBlock(blockIdentity(await read(i, "eth_getBlockByNumber", [receipt.blockNumber, false]), null), block)) throw new Error("The receipt block changed. Do not send again.");
        evidence.push({ safe, block, result });
      }
      if (JSON.stringify(evidence[0]) !== JSON.stringify(evidence[1])) throw new Error("Base readers disagree on confirmed expiry.");
      return evidence[0].result;
    }
    const key = (contract, account) => `agentbounties:recovery:v1:${address(contract)}:${address(account)}`;
    function saved(contract, account) {
      const raw = storage.getItem(key(contract, account));
      if (!raw) return null;
      let value;
      try { value = JSON.parse(raw); } catch (_) { throw new Error("The saved wallet request cannot be read. Stop and check wallet activity."); }
      if (value.contract !== address(contract) || value.account !== address(account) || !["cancel", "refund", "expire_claim"].includes(value.action) || !/^0x[0-9a-f]+$/i.test(value.startBlock)) throw new Error("The saved wallet request is invalid. Stop and check wallet activity.");
      if (value.action === "expire_claim") {
        expiryRound(value.round); address(value.solver); hash(value.bountyId);
        if (value.chainId !== CHAIN || !Number.isSafeInteger(value.deadline) || value.deadline <= 0 || !/^[1-9][0-9]*$/.test(value.bond) || !/^[1-9][0-9]*$/.test(value.expectedPool)) throw new Error("The saved expiry request is invalid. Check wallet activity.");
      }
      if (value.txHash) hash(value.txHash);
      return value;
    }
    function save(record) {
      const name = key(record.contract, record.account), encoded = JSON.stringify(record);
      storage.setItem(name, encoded);
      if (storage.getItem(name) !== encoded) throw new Error("This browser cannot save recovery progress. No new request can be sent safely.");
    }
    async function walletContext(provider, account) {
      const [chain, accounts] = await Promise.all([walletRead(provider, "eth_chainId", walletReadTimeoutMs), walletRead(provider, "eth_accounts", walletReadTimeoutMs)]);
      if (String(chain).toLowerCase() !== CHAIN || address(accounts?.[0]) !== address(account)) throw new Error("Your wallet or network changed. Reconnect the original wallet on Base.");
    }
    function eligible(view, account, action) {
      if (address(account) !== view.creator) throw new Error("Connect the wallet that created this bounty.");
      if (action === "cancel" && ![0, 1].includes(view.state)) throw new Error("This bounty cannot be cancelled while claimed, under review, settled, or already cancelled.");
      if (action === "refund" && (view.state !== 5 || BigInt(view.contribution) <= 0n)) throw new Error("A confirmed cancellation and a remaining contribution are required for a refund.");
    }
    async function requestExpiry({ contract, account, round, reviewed, provider, onProgress = () => {} }) {
      contract = address(contract); account = address(account); round = expiryRound(round);
      if (!reviewed || reviewed.round !== round) throw new Error("Review the current claim and its bond before continuing.");
      if (!locks?.request) throw new Error("This browser cannot safely coordinate wallet requests.");
      return locks.request(key(contract, account), { ifAvailable: true }, async lock => {
        if (!lock || saved(contract, account)) throw new Error("Check the previous wallet request before sending another.");
        onProgress("wallet_check"); await walletContext(provider, account);
        onProgress("bounty_check");
        const intent = await plan("expire_claim", contract, account);
        if (address(intent.from) !== account || address(intent.to) !== contract || String(intent.value_wei) !== "0" || intent.function !== "expireClaim()" || intent.data?.toLowerCase() !== selector("expireClaim()")) throw new Error("The plan does not match this expiry request.");
        const view = await expirySnapshot(contract, round, account, true);
        for (const field of ["contract", "bountyId", "termsHash", "round", "deadline", "solver", "bond", "pool", "funded"]) if (view[field] !== reviewed[field]) throw new Error("The reviewed claim or bond changed. Check status and review it again.");
        await walletContext(provider, account);
        const record = { contract, account, action: "expire_claim", chainId: CHAIN, round, deadline: view.deadline, solver: view.solver, bond: view.bond, expectedPool: (BigInt(view.pool) + BigInt(view.bond)).toString(), startBlock: view.block, bountyId: view.bountyId, createdAt: now(), txHash: null };
        save(record);
        let receivedHash = false;
        try {
          onProgress("wallet_approval");
          const returned = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: contract, value: "0x0", data: selector("expireClaim()"), chainId: CHAIN }] });
          receivedHash = true; // An invalid/lost returned hash still cannot permit another send.
          record.txHash = hash(returned); save(record); return record;
        } catch (error) {
          if (error?.code === 4001 && !receivedHash && !record.txHash) storage.removeItem(key(contract, account));
          throw error;
        }
      });
    }
    async function request({ contract, account, action, provider, onProgress = () => {} }) {
      contract = address(contract); account = address(account);
      if (!["cancel", "refund"].includes(action)) throw new Error("Unsupported recovery action.");
      if (!locks?.request) throw new Error("This browser cannot safely coordinate wallet requests. Use a supported browser.");
      return locks.request(key(contract, account), { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("A recovery request is already open in another tab.");
        if (saved(contract, account)) throw new Error("Check the previous wallet request before sending another.");
        onProgress("wallet_check");
        await walletContext(provider, account);
        onProgress("bounty_check");
        const view = await snapshot(contract, account);
        eligible(view, account, action);
        const expected = selector(action === "cancel" ? "cancel()" : "withdrawRefund()");
        const intent = await plan(action, contract, account);
        if (address(intent.from) !== account || address(intent.to) !== contract || BigInt(intent.value_wei) !== 0n || intent.data?.toLowerCase() !== expected) throw new Error("The planned wallet call does not match the action you reviewed.");
        const latest = await snapshot(contract, account, "latest");
        eligible(latest, account, action);
        if (latest.bountyId !== view.bountyId || latest.funded !== view.funded || latest.pool !== view.pool || latest.contribution !== view.contribution) throw new Error("The bounty balance changed. Refresh and review it again.");
        const tx = { from: account, to: contract, value: "0x0", data: expected, chainId: CHAIN };
        await rpc("eth_estimateGas", [tx]);
        await walletContext(provider, account);
        const record = { contract, account, action, startBlock: view.block, bountyId: view.bountyId, createdAt: now(), txHash: null };
        save(record); // Before opening the wallet: a lost response must not cause a repeat.
        try {
          onProgress("wallet_approval");
          record.txHash = hash(await provider.request({ method: "eth_sendTransaction", params: [tx] }));
          save(record);
          return record;
        } catch (error) {
          if (error?.code === 4001) storage.removeItem(key(contract, account));
          throw error;
        }
      });
    }
    async function reconcile(contract, account) {
      const name = key(contract, account), original = storage.getItem(name);
      let record = saved(contract, account);
      if (!record) {
        const archived = storage.getItem(`${name}:confirmed`);
        if (!archived) return { status: "idle" };
        let prior; try { prior = JSON.parse(archived); } catch (_) { throw new Error("Saved confirmation cannot be read."); }
        if (prior.action !== "expire_claim") return { status: "idle" };
        record = prior.request;
        if (!record || record.action !== "expire_claim" || record.contract !== address(contract) || record.account !== address(account) || !record.txHash) throw new Error("Saved expiry confirmation is invalid.");
        expiryRound(record.round); hash(record.txHash); hash(record.bountyId); address(record.solver);
        if (record.chainId !== CHAIN || !Number.isSafeInteger(record.deadline) || record.deadline <= 0 || !/^[1-9][0-9]*$/.test(record.bond) || !/^[1-9][0-9]*$/.test(record.expectedPool)) throw new Error("Saved expiry confirmation is invalid.");
        return expiryReceipt(record);
      }
      async function settle(result) {
        await locks.request(name, { ifAvailable: true }, lock => {
          if (!lock || storage.getItem(name) !== original) return;
          const confirmed = JSON.stringify({ ...result, request: record });
          storage.setItem(`${name}:confirmed`, confirmed);
          if (storage.getItem(`${name}:confirmed`) !== confirmed) throw new Error("Confirmation could not be saved. The pending request remains blocked.");
          storage.removeItem(name);
        });
        return result;
      }
      if (!record.txHash) return { status: "unknown", message: "The wallet response was lost. Check wallet activity; do not send another request." };
      if (record.action === "expire_claim") {
        const result = await expiryReceipt(record);
        return ["confirmed", "failed"].includes(result.status) ? settle(result) : result;
      }
      const [receipt, safe] = await Promise.all([
        rpc("eth_getTransactionReceipt", [record.txHash]), rpc("eth_getBlockByNumber", ["safe", false]),
      ]);
      if (!receipt || !safe || BigInt(receipt.blockNumber) > BigInt(safe.number)) return { status: "pending", txHash: record.txHash };
      const [block, transaction] = await Promise.all([
        rpc("eth_getBlockByNumber", [receipt.blockNumber, false]), rpc("eth_getTransactionByHash", [record.txHash]),
      ]);
      const expectedData = selector(record.action === "cancel" ? "cancel()" : "withdrawRefund()");
      if (!block || block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) return { status: "pending", txHash: record.txHash };
      if (!transaction || hash(receipt.transactionHash) !== record.txHash || hash(transaction.hash) !== record.txHash || address(transaction.from) !== record.account || address(transaction.to) !== record.contract || transaction.input?.toLowerCase() !== expectedData || BigInt(transaction.value) !== 0n) throw new Error("The transaction does not match the saved recovery request.");
      if (BigInt(receipt.status) === 0n) {
        return settle({ status: "failed", txHash: record.txHash });
      }
      if (BigInt(receipt.status) !== 1n) throw new Error("Unknown transaction result.");
      const eventTopic = topic(record.action === "cancel" ? "BountyCancelled(bytes32,uint256)" : "RefundWithdrawn(bytes32,address,uint256,uint256,uint256)");
      const matches = (receipt.logs || []).filter(log => !log.removed && log.address?.toLowerCase() === record.contract && log.topics?.[0]?.toLowerCase() === eventTopic && log.topics?.[1]?.toLowerCase() === record.bountyId);
      if (matches.length !== 1) throw new Error("The expected confirmed recovery event is missing.");
      const event = matches[0];
      if (record.action === "refund" && (event.topics.length !== 3 || event.topics[2]?.toLowerCase() !== `0x${evm.addressWord(record.account)}` || !/^0x[0-9a-f]{192}$/i.test(event.data))) throw new Error("The refund event does not belong to this wallet.");
      if (record.action === "cancel" && (event.topics.length !== 2 || !/^0x[0-9a-f]{64}$/i.test(event.data))) throw new Error("The cancellation event is invalid.");
      const amount = record.action === "refund" ? uint(`0x${event.data.slice(-64)}`).toString() : null;
      const result = { status: "confirmed", action: record.action, txHash: record.txHash, amount };
      return settle(result);
    }
    return { snapshot, expirySnapshot, requestExpiry, request, reconcile, saved };
  }
  return Object.freeze({ create, createRpc, createExpiryRpc, expiryRound, address, usdc, connectWallet, switchToBase, walletRead, CHAIN, FACTORY, IMPLEMENTATION, TOKEN, CODE, selector, topic });
});
