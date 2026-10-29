const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const publication = require('../site/terms-publication.js');
const evmContext = {window:{}, TextEncoder};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../site/evm.js'),'utf8'), evmContext);
const evm = evmContext.window.AgentBountiesEvm;
const address = '0x' + '11'.repeat(20);
const doc = {contract_terms:{creator_wallet:address,creation_nonce:'0x'+'22'.repeat(32),funding_deadline:1900000000},
  title:'Expected',acceptance_criteria:['Exact files'],verification_policy:{threshold:2},benchmark:{engine:'test'},evidence_schema:{type:'object'}};
function record(document=doc) {
  document = {source_url:null,discovery_source:null,...document};
  const result = {document,creator_wallet:address};
  for (const [key,value] of [['terms_hash',document],['policy_hash',document.verification_policy],['acceptance_criteria_hash',document.acceptance_criteria],['benchmark_hash',document.benchmark],['evidence_schema_hash',document.evidence_schema]]) result[key]=evm.keccak256Hex(evm.textHex(publication.canonical(value)));
  return result;
}
function windowFixture(){const storage=new Map();return {crypto:webcrypto,AgentBountiesEvm:evm,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};}
const body = () => ({creator_wallet:address,document:structuredClone(doc)});
const api='https://api.agentizable.ai';
test('retry preserves key, nonce and deadline; changed approved content gets a new key',()=>{
 const win=windowFixture(),first=publication.reserve(win,'direct',{draft:1},body()),next=body();
 next.document.contract_terms.creation_nonce='0x'+'33'.repeat(32);next.document.contract_terms.funding_deadline++;
 assert.deepEqual(publication.reserve(win,'direct',{draft:1},next),first);
 assert.notEqual(publication.reserve(win,'direct',{draft:2},next).key,first.key);
});
test('corrupted saved content cannot replace approved content; unavailable storage stops before publication',()=>{
 const win=windowFixture(),first=publication.reserve(win,'direct',{draft:1},body()); first.payload.document.title='Changed';
 win.sessionStorage.setItem('agent-bounties:terms-publication:v1:direct',JSON.stringify(first));
 assert.throws(()=>publication.reserve(win,'direct',{draft:1},body()),/saved publication/);
 assert.throws(()=>publication.reserve({crypto:webcrypto,AgentBountiesEvm:evm,sessionStorage:{getItem:()=>null,setItem:()=>{throw Error('storage unavailable');}}},'direct',{},body()),/storage unavailable/);
});
test('corrupted nonce, deadline, envelope JSON or saved key fails before any request',()=>{
 for(const corrupt of [s=>{s.payload.document.contract_terms.creation_nonce='0x'+'99'.repeat(32);},s=>{s.payload.document.contract_terms.funding_deadline++;},s=>{s.key='bad';}]){
  const win=windowFixture(),saved=publication.reserve(win,'direct',{},body());corrupt(saved);
  win.sessionStorage.setItem('agent-bounties:terms-publication:v1:direct',JSON.stringify(saved));
  assert.throws(()=>publication.reserve(win,'direct',{},body()),/saved publication/);
 }
 const win=windowFixture();win.sessionStorage.setItem('agent-bounties:terms-publication:v1:direct','{');
 assert.throws(()=>publication.reserve(win,'direct',{},body()));
});
test('success verifies exact document, creator and every commitment',async()=>{
 const saved=publication.reserve(windowFixture(),'direct',{},body()),calls=[];
 const result=await publication.publish(windowFixture(),api,saved,async(url,options)=>{calls.push([url,options]);return record();},{},evm);
 assert.equal(result.terms_hash,record().terms_hash);assert.equal(calls.length,1);assert.equal(calls[0][1].headers['Idempotency-Key'],saved.key);
 for (const field of ['terms_hash','policy_hash','acceptance_criteria_hash','benchmark_hash','evidence_schema_hash']) assert.throws(()=>publication.validate({...record(),[field]:'0x'+'00'.repeat(32)},address,doc,evm),/does not match/);
 assert.throws(()=>publication.validate({...record(),creator_wallet:'0x'+'44'.repeat(20)},address,doc,evm),/differ/);
 assert.throws(()=>publication.validate(record({...doc,title:'Other'}),address,doc,evm),/differ/);
});
test('409 exact readback always stops; repeated clicks never bypass publication reconciliation',async()=>{
 const win=windowFixture(),saved=publication.reserve(win,'direct',{},body()),calls=[],path='/v1/base/autonomous-bounties/terms/'+record().terms_hash;
 const request=async(url,options)=>{calls.push([url,options]);if(options.method==='POST')throw Object.assign(Error('exists'),{status:409,body:{error_code:'publication_already_exists',next_action_url:path}});return record();};
 await assert.rejects(publication.publish(win,api,saved,request,{},evm),/Check the original posting/);assert.equal(calls.length,2);
 const retry=publication.reserve(win,'direct',{},body());await assert.rejects(publication.publish(win,api,retry,request,{},evm), /Check the original posting/);
 assert.equal(calls.length,4);assert.equal(calls.filter(([,o])=>o.method==='POST').length,2);
});
test('409 cannot redirect credentials or substitute a different record; non-publication conflicts do not GET',async()=>{
 for(const target of ['https://evil.test/terms','//evil.test/terms','/v1/base/autonomous-bounties/terms/../auth','/v1/base/autonomous-bounties/terms/0x'+'00'.repeat(32)]){
  const calls=[],saved=publication.reserve(windowFixture(),'direct',{},body());
  await assert.rejects(publication.publish(windowFixture(),api,saved,async(url,o)=>{calls.push(url);if(o.method==='POST')throw Object.assign(Error(),{status:409,body:{error_code:'publication_already_exists',next_action_url:target}});return record();},{},evm));
  assert.equal(calls.length,target.endsWith('00'.repeat(32))?2:1);
 }
 let calls=0;await assert.rejects(publication.publish(windowFixture(),api,publication.reserve(windowFixture(),'direct',{},body()),async()=>{calls++;throw Object.assign(Error('conflict'),{status:409,body:{error_code:'publication_idempotency_conflict'}});},{},evm),/conflict/);assert.equal(calls,1);
});
function authFixture({kind='browser',linked=false,confirm=true,capabilities={},errorCode='publication_wallet_authority_required'}={}){
 const source=fs.readFileSync(path.join(__dirname,'../site/bounty-composer-v2.js'),'utf8');
 const snippet=source.slice(source.indexOf('  async function publicationRequest('),source.indexOf('  function draftContext('));
 const calls=[],logins=[],checks=[];let count=0;
 const state={account:address,providerKind:kind,provider:{agentBountiesCapabilities:capabilities},linkedWallets:linked?[{address}]:[]};
 const context={state,window:{confirm:()=>confirm,AgentBountiesWalletSession:{authenticate:async(...args)=>{logins.push(args);return 'abws_'+'a'.repeat(64);}}},assertPostingBinding:async()=>checks.push(true),requestJson:async(url,options)=>{calls.push({url,options});if(++count===1)throw Object.assign(Error('auth'),{status:403,body:{error_code:errorCode}});return {ok:true};}};
 vm.runInNewContext(snippet+';globalThis.run=publicationRequest;',context);return {...context,calls,logins,checks};
}
test('unlinked external wallet ownership login is explicit, keeps key/body and drops cookies on bearer retry',async()=>{
 const f=authFixture(),options={method:'POST',headers:{'Idempotency-Key':'saved'},body:'exact'};
 await f.run(api,api+'/terms',options);assert.equal(f.logins.length,1);assert.equal(f.checks.length,2);
 assert.equal(f.calls[1].options.credentials,'omit');assert.equal(f.calls[1].options.headers['Idempotency-Key'],'saved');assert.equal(f.calls[1].options.body,'exact');assert.match(f.calls[1].options.headers.Authorization,/^Bearer abws_/);
});
test('linked authority failure, unsupported embedded wallet, cancellation and unrelated errors never request SIWE or retry',async()=>{
 for(const options of [{linked:true},{kind:'embedded'},{capabilities:{reviewedPostingOnly:true}},{capabilities:{directTransactions:false}},{confirm:false},{errorCode:'publication_authentication_unavailable'}]){
  const f=authFixture(options);await assert.rejects(f.run(api,api+'/terms',{method:'POST'}));assert.equal(f.logins.length,0);assert.equal(f.calls.length,1);
 }
});

const readbackCases = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/terms-publication-readback.json'),'utf8')).cases;
for (const fixture of readbackCases) test('server-shaped readback: '+fixture.name,async()=>{
 const wire=structuredClone(fixture.request),before=JSON.stringify(wire),win=windowFixture();
 const saved=publication.reserve(win,'direct',{},wire),key=saved.key,payloadHash=saved.payload_hash,calls=[];
 const request=async(url,options)=>{calls.push(options);return structuredClone(fixture.record);};
 for(let retry=0;retry<2;retry++)assert.deepEqual(await publication.publish(win,api,saved,request,{},evm),fixture.record);
 assert.equal(JSON.stringify(wire),before);assert.equal(saved.key,key);assert.equal(saved.payload_hash,payloadHash);
 assert.ok(calls.every(o=>o.body===before&&o.headers['Idempotency-Key']===key));
});
test('normalization never discards unknown requirements or changes arbitrary JSON values',()=>{
 const f=readbackCases[0], image=readbackCases[3];
 for(const changed of [{...f.request.document,goal:'Different goal'},
   {...f.request.document,unknown_requirement:'must not disappear'},
   {...f.request.document,benchmark:{...f.request.document.benchmark,extra:null}},
   {...f.request.document,contract_terms:{...f.request.document.contract_terms,extra:null}},
   {...f.request.document,agent_eligibility:{unknown_requirement:true}},
   {...f.request.document,claim_coordination:{waitlist_capacity:null}}])
  assert.throws(()=>publication.validate(f.record,f.request.creator_wallet,changed,evm));
 for(const change of [{alt_text:'Different'},{unknown_requirement:'preserve'}])
  assert.throws(()=>publication.validate(image.record,image.request.creator_wallet,{...image.request.document,image:{...image.request.document.image,...change}},evm));
});
