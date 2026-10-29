import assert from 'node:assert/strict';
import test from 'node:test';
import {keccak_256} from '@noble/hashes/sha3';
import {AgentBountiesClient,AgentBountiesHttpError} from '../dist/index.js';
const creator='0x'+'11'.repeat(20),document={acceptance_criteria:['deliver'],benchmark:{},evidence_schema:{},title:'Expected',verification_policy:{}};
const hash=v=>'0x'+Buffer.from(keccak_256(new TextEncoder().encode(JSON.stringify(v)))).toString('hex');
const record={creator_wallet:creator,document,terms_hash:hash(document),policy_hash:hash({}),acceptance_criteria_hash:hash(['deliver']),benchmark_hash:hash({}),evidence_schema_hash:hash({})};
test('publication requires caller key, keeps credential and exact retries, never auto-follows409',async()=>{
 const prior=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({error_code:'publication_already_exists',next_action_url:'/v1/base/autonomous-bounties/terms/'+record.terms_hash}),{status:409});};
 try{
  const client=new AgentBountiesClient({baseUrl:'https://example.test',sessionToken:'abws_'+'a'.repeat(64)});
  for(const key of ['',undefined,'x\n','x'.repeat(201)])await assert.rejects(client.publishAutonomousBountyTerms(creator,document,key),/stable printable/);
  assert.equal(calls.length,0);
  for(let i=0;i<2;i++)await assert.rejects(client.publishAutonomousBountyTerms(creator,document,'saved'),e=>e instanceof AgentBountiesHttpError&&e.body.error_code==='publication_already_exists');
  assert.equal(calls.length,2);assert.equal(calls[0].init.body,calls[1].init.body);
  for(const {init} of calls){assert.equal(init.method,'POST');assert.equal(init.headers['Idempotency-Key'],'saved');assert.equal(init.headers.authorization,'Bearer abws_'+'a'.repeat(64));}
 }finally{globalThis.fetch=prior;}
});
test('explicit readback validates all expected commitments and never writes',async()=>{
 const prior=globalThis.fetch,calls=[];let value=record;
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(value));};
 try{
  const client=new AgentBountiesClient({baseUrl:'https://example.test'});
  assert.deepEqual(await client.getVerifiedAutonomousBountyTerms(record.terms_hash,creator,document),record);
  for(const changed of [{...record,creator_wallet:'wrong'},{...record,document:{...document,title:'Changed'}},{...record,benchmark_hash:'0x'+'00'.repeat(32)}]){value=changed;await assert.rejects(client.getVerifiedAutonomousBountyTerms(record.terms_hash,creator,document));}
  assert.ok(calls.every(({init})=>init.method===undefined));
 }finally{globalThis.fetch=prior;}
});
