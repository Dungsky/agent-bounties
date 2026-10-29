/* Publication retries preserve exact terms. Ownership login cannot authorize payment. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AgentBountiesTermsPublication = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const PREFIX = "agent-bounties:terms-publication:v1:";
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
    const result = JSON.stringify(value);
    if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Publication content must be JSON.");
    return result;
  }
  function intent(scope, payload) {
    const value = JSON.parse(JSON.stringify(payload));
    if (scope === "direct") {
      // These two values are created once, not part of the editable brief.
      delete value.document.contract_terms.creation_nonce;
      delete value.document.contract_terms.funding_deadline;
    }
    return canonical(value);
  }
  function reserve(win, scope, binding, payload) {
    const name = PREFIX + scope, fingerprint = canonical(binding);
    const hash = value => win.AgentBountiesEvm.keccak256Hex(win.AgentBountiesEvm.textHex(canonical(value)));
    const previous = JSON.parse(win.sessionStorage.getItem(name) || "null");
    if (previous?.fingerprint === fingerprint) {
      if (!/^publication-[0-9a-f-]{36}$/.test(previous.key) || !previous.payload || previous.payload_hash !== hash(previous.payload) || intent(scope, previous.payload) !== intent(scope, payload)) throw new Error("The saved publication is invalid. Keep your draft and check its status.");
      return previous;
    }
    const saved = { fingerprint, key: "publication-" + win.crypto.randomUUID(), payload, payload_hash: hash(payload) };
    win.sessionStorage.setItem(name, JSON.stringify(saved));
    return saved;
  }
  function validate(record, creator, document, evm) {
    if (!record || String(record.creator_wallet).toLowerCase() !== creator.toLowerCase()
      || canonical(record.document) !== canonical(document)) throw new Error("Published terms differ from the approved document or creator. No wallet action was requested.");
    for (const [key, value] of [["terms_hash", document], ["policy_hash", document.verification_policy],
      ["acceptance_criteria_hash", document.acceptance_criteria], ["benchmark_hash", document.benchmark], ["evidence_schema_hash", document.evidence_schema]]) {
      const expected = evm.keccak256Hex(evm.textHex(canonical(value)));
      if (record[key] !== expected) throw new Error("The published " + key + " does not match the approved content.");
    }
    return record;
  }
  function existingPath(problem) {
    const path = problem?.next_action_url;
    if (!/^\/v1\/base\/autonomous-bounties\/terms\/0x[0-9a-f]{64}$/.test(path || "")) throw new Error("The existing terms address is invalid. No wallet action was requested.");
    return path;
  }
  async function publish(win, api, saved, request, headers, evm) {
    const { creator_wallet: creator, document } = saved.payload;
    const read = async path => {
      const record = validate(await request(api + path, { cache: "no-store" }), creator, document, evm);
      if (!path.endsWith("/" + record.terms_hash)) throw new Error("The existing terms identity changed.");
      return record;
    };
    try {
      return validate(await request(api + "/v1/base/autonomous-bounties/terms", {
        method: "POST", headers: { ...headers, "Idempotency-Key": saved.key }, body: JSON.stringify(saved.payload),
      }), creator, document, evm);
    } catch (error) {
      if (error.status !== 409 || error.body?.error_code !== "publication_already_exists") throw error;
      const path = existingPath(error.body);
      await read(path);
      const stopped = new Error("These exact terms already exist and match your draft. Check the original posting in your account before continuing. No signing or funding was requested. Terms: " + api + path);
      stopped.code = "publication_reconciliation_required";
      stopped.next_action_url = "/account.html";
      throw stopped;
    }
  }
  return { canonical, reserve, validate, existingPath, publish };
});
