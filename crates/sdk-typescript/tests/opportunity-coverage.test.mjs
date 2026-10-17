import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentBountiesClient } from '../dist/index.js';
test('partial and unavailable source metadata survives without zero inference', async () => {
  const previous = globalThis.fetch;
  try {
    for (const [coverage, items] of [['partial', [{title:'Checked work'}]], ['unavailable', []]]) {
      const payload = {coverage, coverage_scope:'inventory_page', degraded:true, source_statuses:[{source_type:'canonical_base', available:false, coverage, protocol_statuses:[{protocol:'open-competition-v2-beta3',coverage:'unavailable',item_count:null}]}], items};
      globalThis.fetch = async (url, init) => {
        assert.equal(init.method ?? 'GET', 'GET');
        assert.equal(new URL(url).searchParams.get('opportunity_id'), 'canonical:base-mainnet:0x'+'12'.repeat(20));
        return new Response(JSON.stringify(payload), {status:200});
      };
      const result = await new AgentBountiesClient({baseUrl:'https://example.test'}).listOpportunities({opportunity_id:'canonical:base-mainnet:0x'+'12'.repeat(20)});
      assert.deepEqual(result, payload);
    }
  } finally { globalThis.fetch = previous; }
});
