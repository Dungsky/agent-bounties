// Customer review of a card-paid bounty, shown in the solver's workspace. The paying customer
// decides each submission; a rejection waits 48 hours for the solver's appeal before it is signed.
// The solver of the rejected submission appeals by signing the exact public reason in their wallet.
// The review state is public and names no customer. Nothing here proves payment: only a confirmed
// canonical BountySettled does.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) api.start(root, root.document);
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const CHAINS = { "base-mainnet": 8453, "base-sepolia": 84532 };
  const APPEALS = ["window_open", "appealed", "upheld", "final", "reversed"];
  const WORD = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
  const lower = (value) => String(value || "").toLowerCase();
  function check(ok) { if (!ok) throw new Error("The review state could not be verified. Refresh before you act."); }
  const integer = (v) => Number.isSafeInteger(v) && v > 0;

  // The public review state of exactly this bounty; anything else fails closed.
  function cardReview(v, contract, network) {
    check(v && v.network === network && lower(v.bounty_contract) === contract && Array.isArray(v.reviews) && typeof v.bounty_status === "string");
    let pending = null;
    if (v.pending_submission !== null) {
      const p = v.pending_submission;
      check(p && integer(p.round) && ADDRESS.test(lower(p.solver)) && WORD.test(p.submission_hash) && integer(p.verification_expires_at)
        && integer(p.decide_by) && p.decide_by <= p.verification_expires_at);
      pending = { round: p.round, solver: lower(p.solver), submission_hash: p.submission_hash, decide_by: p.decide_by, published: Boolean(p.evidence) };
    }
    const reviews = v.reviews.map((r) => {
      const d = r?.document;
      check(d && d.schema === "agent-bounties/customer-review-v1" && lower(d.bounty_contract) === contract && integer(d.round)
        && typeof d.passed === "boolean" && typeof d.reason === "string" && WORD.test(d.submission_hash) && WORD.test(r.response_hash)
        && ["customer", "deadline"].includes(r.decided_by));
      let appeal = null;
      if (r.appeal !== null && r.appeal !== undefined) {
        check(!d.passed && APPEALS.includes(r.appeal.status) && integer(r.appeal.window_ends_at));
        appeal = { status: r.appeal.status, window_ends_at: r.appeal.window_ends_at, reason: r.appeal.document?.reason ?? null };
      }
      const ruling = r.ruling?.document ? { reversed: r.ruling.document.passed === true, reason: String(r.ruling.document.reason) } : null;
      return { round: d.round, passed: d.passed, reason: d.reason, decided_by: r.decided_by, submission_hash: d.submission_hash,
        rejection_hash: r.response_hash, appeal, ruling };
    });
    let payout = null;
    if (v.deposit_payout) {
      const p = v.deposit_payout;
      check(["owed", "paid"].includes(p.status) && integer(p.amount_micro_usdc) && ADDRESS.test(lower(p.solver))
        && (p.status === "owed" ? p.tx_hash === null : WORD.test(p.tx_hash)));
      payout = { status: p.status, amount: p.amount_micro_usdc, solver: lower(p.solver), tx_hash: p.tx_hash };
    }
    return { network, contract, status: v.bounty_status, pending, reviews, payout };
  }

  function reasonOk(reason) {
    const length = Array.from(String(reason)).length;
    return typeof reason === "string" && reason === reason.trim() && length >= 20 && length <= 2000
      && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(reason);
  }

  // The rejection this wallet may appeal now: its own still-pending submission in an open window.
  function appealable(model, wallet, now) {
    if (!ADDRESS.test(lower(wallet)) || !model.pending || model.pending.solver !== lower(wallet)) return null;
    return model.reviews.find((r) => r.round === model.pending.round && !r.passed && r.appeal?.status === "window_open"
      && r.submission_hash === model.pending.submission_hash && now < r.appeal.window_ends_at) || null;
  }

  // Built here, not taken from the server, so the wallet signs exactly this reason and bounty.
  function appealTypedData(model, review, reason) {
    check(reasonOk(reason) && CHAINS[model.network]);
    const field = (name, type) => ({ name, type });
    return {
      types: {
        EIP712Domain: [field("name", "string"), field("version", "string"), field("chainId", "uint256"), field("verifyingContract", "address")],
        ReviewAppeal: [field("bounty", "address"), field("round", "uint64"), field("submissionHash", "bytes32"), field("rejectionHash", "bytes32"), field("reason", "string")],
      },
      primaryType: "ReviewAppeal",
      domain: { name: "Agent Bounties", version: "1", chainId: CHAINS[model.network], verifyingContract: model.contract },
      message: { bounty: model.contract, round: review.round, submissionHash: review.submission_hash, rejectionHash: review.rejection_hash, reason },
    };
  }

  const when = (seconds) => new Date(seconds * 1000).toLocaleString();
  const usdc = (micro) => `${(micro / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;

  // Plain-language lines for each round, latest first. Payment and reopening are stated as done
  // only on canonical evidence: bounty_status "paid" is a confirmed BountySettled, and a deposit
  // payout is "paid" only after its transfer was verified on chain.
  function roundText(r, model) {
    if (r.passed) return r.decided_by === "deadline"
      ? `Attempt ${r.round}: accepted automatically because the customer did not decide in time.`
      : `Attempt ${r.round}: accepted by the customer.`;
    const base = `Attempt ${r.round}: rejected. Reason: ${r.reason}`;
    const reopens = "Once the signed rejection is confirmed on chain, the solver's bond goes to the verifier and the bounty reopens for another attempt.";
    switch (r.appeal?.status) {
      case "window_open": return `${base} The solver can appeal until ${when(r.appeal.window_ends_at)}. Without an appeal the rejection becomes final.`;
      case "appealed": return `${base} The solver appealed. Agent Bounties is checking the delivery against the published criteria.`;
      case "upheld": return `${base} On appeal the rejection was upheld: ${r.ruling?.reason || ""} ${reopens}`;
      case "reversed": {
        const latest = r.round === Math.max(...model.reviews.map((x) => x.round));
        const paid = model.status === "paid" && latest
          ? "The bounty settled and paid the solver."
          : "The solver is paid when the bounty settles on chain.";
        const payout = model.payout;
        return `${base} On appeal the rejection was reversed: ${r.ruling?.reason || ""} ${paid} The customer's review deposit goes to the solver${payout ? ` (${usdc(payout.amount)}, ${payout.status === "paid" ? "sent" : "owed"})` : ""}.`;
      }
      default: return `${base} The rejection is final. ${reopens}`;
    }
  }

  function summary(model) {
    if (model.pending) return model.pending.published
      ? `The customer who paid by card reviews this delivery against the published criteria. They decide by ${when(model.pending.decide_by)}. If they don't decide by then, it is accepted automatically.`
      : "The customer who paid by card reviews each delivery. Their 3-day decision period starts when the delivery's evidence is published.";
    return "The customer who paid by card reviews each delivery against the published criteria. A rejection can be appealed within 48 hours.";
  }

  function start(win, doc) {
    const section = doc.querySelector("[data-card-review]");
    if (!section || !win.AgentBountiesWorkflow) return;
    const flow = win.AgentBountiesWorkflow, client = flow.createClient(win);
    const params = new URLSearchParams(win.location.search);
    const contract = lower(params.get("bountyContract")), network = params.get("network") || flow.NETWORK;
    const find = (s) => section.querySelector(s), put = (s, text) => { find(s).textContent = text; };
    let model = null, wallet = null, provider = null, busy = false;
    const key = (round) => `agent-bounties.card-appeal.v1:${network}:${contract}:${round}`;
    const saved = (round) => { try { return JSON.parse(win.sessionStorage.getItem(key(round)) || "null"); } catch (_) { return null; } };
    const save = (round, value) => { try { win.sessionStorage.setItem(key(round), JSON.stringify(value)); } catch (_) {} };

    function render() {
      section.hidden = false;
      put("[data-card-review-summary]", summary(model));
      const list = find("[data-card-review-rounds]"); list.replaceChildren();
      for (const r of model.reviews) { const li = doc.createElement("li"); li.textContent = roundText(r, model); list.append(li); }
      const payout = find("[data-card-payout]");
      payout.replaceChildren();
      if (model.payout) {
        payout.append(model.payout.status === "paid"
          ? `Review deposit paid to the solver: ${usdc(model.payout.amount)}. `
          : `Review deposit owed to the solver: ${usdc(model.payout.amount)}. Agent Bounties sends it in USDC.`);
        if (model.payout.tx_hash) {
          const link = doc.createElement("a");
          link.href = `https://${model.network === "base-sepolia" ? "sepolia." : ""}basescan.org/tx/${model.payout.tx_hash}`;
          link.rel = "noopener noreferrer"; link.target = "_blank"; link.textContent = "View the transfer on Basescan";
          payout.append(link);
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const open = model.pending && model.reviews.find((r) => r.round === model.pending.round && r.appeal?.status === "window_open");
      const mine = appealable(model, wallet, now);
      find("[data-card-appeal]").hidden = !open;
      if (open) {
        put("[data-card-appeal-note]", `If this was your submission, you can appeal until ${when(open.appeal.window_ends_at)}. Your wallet signs the exact reason below. If the appeal reverses the rejection, you are paid the reward, your bond back and the customer's review deposit. If it is upheld, your bond goes to the verifier.`);
        find("[data-card-appeal-sign]").disabled = !mine || busy || !reasonOk(find("[data-card-appeal-reason]").value.trim());
        find("[data-card-appeal-connect]").hidden = Boolean(wallet);
        if (wallet && !mine) put("[data-card-review-status]", "The connected wallet did not make this submission. Only its solver can appeal.");
        const kept = saved(open.round);
        if (kept && !find("[data-card-appeal-reason]").value) find("[data-card-appeal-reason]").value = kept.reason;
      }
    }
    async function refresh() {
      if (!/^0x[0-9a-f]{40}$/.test(contract) || !CHAINS[network]) return;
      try { model = cardReview(await client.request(`/v1/managed-service/bounties/${network}/${contract}/review`), contract, network); }
      catch (error) {
        // A bounty without a card order has no customer review.
        if (error.status === 404) { section.hidden = true; return; }
        throw error;
      }
      render();
    }
    async function connect() {
      const injected = win.ethereum || win.AgentBountiesPhoneWallet?.provider;
      if (!injected) throw new Error("Open this page in a browser with the wallet that made the submission.");
      provider = injected;
      let accounts = await provider.request({ method: "eth_accounts" });
      if (!accounts?.length) accounts = await provider.request({ method: "eth_requestAccounts" });
      wallet = lower(accounts[0]);
      const chain = `0x${CHAINS[network].toString(16)}`;
      if (lower(await provider.request({ method: "eth_chainId" })) !== chain) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] });
      put("[data-card-review-status]", "");
      await refresh();
    }
    async function appeal() {
      const now = Math.floor(Date.now() / 1000);
      await refresh();
      const review = appealable(model, wallet, now);
      if (!review) throw new Error("This rejection can no longer be appealed by the connected wallet. Refresh to see its state.");
      const reason = find("[data-card-appeal-reason]").value.trim();
      let signed = saved(review.round);
      if (!signed || signed.reason !== reason || signed.solver !== wallet) {
        const typed = appealTypedData(model, review, reason);
        const signature = await provider.request({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(typed)] });
        if (!/^0x(?:[0-9a-f]{2}){65,4096}$/i.test(signature)) throw new Error("The wallet returned no usable signature. Nothing was sent.");
        signed = { reason, solver: wallet, signature };
        save(review.round, signed);
      }
      await client.request(`/v1/managed-service/bounties/${network}/${contract}/appeal`,
        { round: review.round, solver: wallet, reason: signed.reason, signature: signed.signature });
      put("[data-card-review-status]", "Appeal recorded. The rejection stays unsigned until Agent Bounties rules.");
      await refresh();
    }
    const fail = (error) => put("[data-card-review-status]", error.message || String(error));
    find("[data-card-appeal-connect]").addEventListener("click", (event) => { if (event.isTrusted && !busy) connect().catch(fail); });
    find("[data-card-appeal-reason]").addEventListener("input", () => { if (model) render(); });
    find("[data-card-appeal-sign]").addEventListener("click", async (event) => {
      if (!event.isTrusted || busy) return;
      busy = true; find("[data-card-appeal-sign]").disabled = true;
      try { await appeal(); } catch (error) { fail(error); } finally { busy = false; if (model) render(); }
    });
    refresh().catch(fail);
    win.setInterval(() => { if (!doc.hidden && !busy) refresh().catch(fail); }, 30000);
  }
  return { cardReview, appealable, appealTypedData, reasonOk, roundText, summary, start };
});
