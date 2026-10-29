import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setup,connect,signFunding,api} from './sponsored-flow-fixture.mjs';
const results=[];
const tool=(page,name,input={})=>page.evaluate(({name,input})=>window.localPageTools.get(name).execute(input),{name,input});
const status=h=>tool(h.page,'agent_bounties_get_posting_status');
async function pending(h){await h.page.waitForFunction(()=>document.querySelector('[data-fund-now]').textContent==='Continue funding'&&!document.querySelector('[data-fund-now]').disabled);}
async function signatureDialog(h){await h.page.locator('[data-legal-consent-checkbox]').check();await h.page.locator('[data-fund-now]').click();await h.page.getByRole('dialog',{name:'Approve bounty funding signature',exact:true}).waitFor();}
function scenario(name,options,check){for(const mobile of [false,true])test(`${name} (${mobile?'phone':'desktop'})`,{timeout:35000},async()=>{
 const row={scenario:name,viewport:mobile?'phone':'desktop',passed:false};results.push(row);
 const h=await setup({...options,mobile});h.page.setDefaultTimeout(8000);
 try{await connect(h);await check(h);assert.equal(h.state.sent,0,'never requests a customer transaction');assert.deepEqual(h.state.errors,[]);row.passed=true;}
 catch(e){row.error=e.message;row.payment_status=await h.page.locator('[data-payment-status]').innerText().catch(()=>null);row.url=h.page.url();row.page_errors=h.state.errors;row.review=await h.page.evaluate(()=>window.AgentBountiesComposer?.review());row.body=(await h.page.locator('body').innerText()).slice(-3500);row.requests=h.state.requests.filter(r=>r.path).slice(-12);row.api_failures=h.state.requests.filter(r=>r.path&&r.status>=400);throw e;}
 finally{row.signatures=h.state.signed;row.relay_requests=h.state.relayRequests.length;row.customer_transactions=h.state.sent;await h.context.close();}
});}
scenario('one signature and sponsored relay complete only with exact canonical inventory',{eth:'0x0'},async h=>{
 await signatureDialog(h);
 const panel=h.page.locator('.wallet-auth-panel');assert.ok((await panel.boundingBox()).width<=h.page.viewportSize().width);assert.equal(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth),true);
 assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);
 await h.page.getByRole('button',{name:'Sign funding authorization',exact:true}).click();
 await h.page.waitForURL('**/funded.html?**');
 assert.equal(new URL(h.page.url()).searchParams.get('bountyContract'),h.state.plan.predicted_bounty_contract);
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
 assert.ok(h.state.requests.some(r=>r.path==='fixture:authorized-creation-plan'&&r.status===200));
 assert.equal(h.state.calls.some(r=>r.method==='eth_sendTransaction'),false);
 const response=await fetch(api+'/v1/base/autonomous-bounties/terms/'+h.state.terms.terms_hash);assert.equal(response.status,200);
});
scenario('USDC shortfall blocks signatures and relay',{usdc:'0x0'},async h=>{assert.equal(await h.page.locator('[data-fund-now]').isDisabled(),true);assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);});
scenario('unavailable sponsor blocks even a wallet with ETH',{sponsorAvailable:false},async h=>{assert.match(await h.page.locator('#funding-dialog').innerText(),/Waiting for gas sponsorship/);assert.equal(await h.page.locator('[data-fund-now]').isDisabled(),true);assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);});
scenario('missing consent blocks publication and signing',{},async h=>{assert.equal(await h.page.locator('[data-fund-now]').isDisabled(),true);await h.page.locator('[data-fund-now]').evaluate(e=>e.click());assert.equal(h.state.terms,null);assert.equal(h.state.signed,0);});
scenario('synthetic funding click cannot authorize payment',{},async h=>{await h.page.locator('[data-legal-consent-checkbox]').check();await h.page.locator('[data-fund-now]').evaluate(e=>e.click());assert.equal(h.state.terms,null);assert.equal(h.state.signed,0);});
scenario('signature cancellation preserves operation and permits fresh human review',{},async h=>{
 const id=await h.page.evaluate(()=>window.AgentBountiesWorkflow.createClient(window).load().id);
 await signatureDialog(h);await h.page.getByRole('dialog',{name:'Approve bounty funding signature',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 await h.page.waitForFunction(()=>!document.querySelector('[data-fund-now]').disabled);assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);
 await h.page.locator('[data-fund-now]').click();await h.page.getByRole('dialog',{name:'Approve bounty funding signature',exact:true}).waitFor();
 assert.equal(await h.page.evaluate(()=>window.AgentBountiesWorkflow.createClient(window).load().id),id);
 await h.page.getByRole('dialog',{name:'Approve bounty funding signature',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
});
scenario('double click does not duplicate signature or relay',{},async h=>{
 await h.page.locator('[data-legal-consent-checkbox]').check();await h.page.locator('[data-fund-now]').dblclick();
 await h.page.getByRole('button',{name:'Sign funding authorization',exact:true}).click();await h.page.waitForURL('**/funded.html?**');
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
scenario('wallet changed during signature review stops before signing',{},async h=>{
 await signatureDialog(h);await h.page.evaluate(()=>{window.testCdpAddress='0x'+'99'.repeat(20);});
 await h.page.getByRole('button',{name:'Sign funding authorization',exact:true}).click();
 await h.page.waitForFunction(()=>document.body.innerText.includes('changed'));
 assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);
});
scenario('expired authorization during review stops before signing',{},async h=>{
 await signatureDialog(h);await h.page.evaluate(()=>{const future=Date.now()+40*86400000;Date.now=()=>future;});
 await h.page.getByRole('button',{name:'Sign funding authorization',exact:true}).click();
 await h.page.waitForFunction(()=>document.body.innerText.includes('expired'));
 assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);
});
scenario('capacity retry reuses exact signature after reload',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
 assert.equal((await status(h)).public_inventory_verified,false);
 const first=h.state.relayRequests[0];await h.page.reload();await h.page.waitForFunction(()=>window.AgentBountiesComposer);
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
 await tool(h.page,'agent_bounties_open_funding_review');
 // Restore the same wallet through normal UI; session is already authenticated.
 await reconnect(h);h.state.relayStatus=200;await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();
 await h.page.waitForURL('**/funded.html?**');assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,2);assert.deepEqual(h.state.relayRequests[1],first);
});
async function reconnect(h){
 await h.page.locator('[data-wallet-options] button').filter({hasText:'Saved to your account'}).first().click();await h.page.getByRole('button',{name:'Use this wallet',exact:true}).click();
 await h.page.getByRole('button',{name:'Coinbase Use your Base app or Coinbase account wallet.',exact:true}).click();await h.page.getByText('Use an email wallet instead',{exact:true}).click();await h.page.getByRole('button',{name:/Use Coinbase with email/}).click();
 await h.page.waitForFunction(()=>['review','topup'].includes(document.querySelector('#funding-dialog').dataset.fundingView));
}
scenario('confirmed events with missing or wrong inventory cannot complete',{delayInventory:true},async h=>{
 await signFunding(h);await h.page.waitForFunction(()=>window.AgentBountiesComposer.review().canonical_status?.creation_confirmed===true);
 assert.equal((await status(h)).public_inventory_verified,false);h.state.inventory=true;h.state.inventoryContract='0x'+'11'.repeat(20);assert.equal((await status(h)).public_inventory_verified,false);
 h.state.inventoryContract=null;assert.equal((await status(h)).public_inventory_verified,true);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
for(const [label,opts,text] of [['wrong bounty',{wrongRelayBounty:true},'different bounty'],['customer gas charge',{wrongRelayGas:true},'does not match']])scenario(`relay ${label} cannot establish success`,opts,async h=>{
 await signFunding(h);await h.page.waitForFunction(text=>document.body.innerText.includes(text),text);assert.equal((await status(h)).public_inventory_verified,false);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
scenario('lost relay reply reconciles canonical result without resending',{lostReply:true},async h=>{
 await signFunding(h);await pending(h);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);assert.equal((await status(h)).public_inventory_verified,false);
 await h.page.reload();await h.page.waitForFunction(()=>window.AgentBountiesComposer);h.state.canonical=true;h.state.inventory=true;
 assert.equal((await status(h)).public_inventory_verified,true);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
scenario('signature stays out of synchronized draft and WebMCP status',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);const saved=await h.page.evaluate(()=>JSON.parse(sessionStorage.getItem('agent-bounties.posting-continuation.v1')));
 assert.ok(saved.signature);assert.equal(JSON.stringify(await status(h)).includes(saved.signature),false);assert.equal(JSON.stringify(h.state.draftWrites).includes(saved.signature),false);
});
scenario('tampered saved request blocks continuation',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);await h.page.evaluate(()=>{const k='agent-bounties.posting-continuation.v1',d=JSON.parse(sessionStorage.getItem(k));d.create.initial_funding.amount++;sessionStorage.setItem(k,JSON.stringify(d));});
 await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();await h.page.waitForFunction(()=>document.body.innerText.includes('integrity'));assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
scenario('lost signing reply cannot start relay or ask for another signature',{sdkTimeout:true},async h=>{
 await signFunding(h);await h.page.waitForFunction(()=>document.body.innerText.includes('may have been submitted'));
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,0);
 await h.page.reload();await h.page.waitForFunction(()=>window.AgentBountiesComposer);assert.equal((await status(h)).public_inventory_verified,false);assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,0);
});
scenario('changed draft invalidates approval before publication',{},async h=>{
 await tool(h.page,'agent_bounties_stage_funded_bounty',{...h.draft,goal:'A materially different deliverable'});
 assert.equal(await h.page.evaluate(()=>window.AgentBountiesComposer.review().explicitly_approved),false);assert.equal(await h.page.locator('[data-fund-now]').isDisabled(),true);assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);
});
scenario('changed legal policy blocks a saved authorization retry',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);h.state.legalChanged=true;
 await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();
 await pending(h);assert.equal(h.state.relayRequests.length,1,'A changed legal policy must block the second relay request in the same tab');assert.match(await h.page.locator('body').innerText(),/legal terms changed/);assert.equal(h.state.signed,1);
});
scenario('transaction hash alone cannot establish funding',{deferCanonical:true},async h=>{
 await signFunding(h);await h.page.waitForFunction(()=>window.AgentBountiesComposer.review().posting_operation?.transactions.length===1);
 assert.equal(h.state.relayRequests.length,1);assert.equal((await status(h)).public_inventory_verified,false);assert.equal(new URL(h.page.url()).pathname,'/post.html');
 h.state.canonical=true;h.state.inventory=true;await h.page.waitForURL('**/funded.html?**');assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
scenario('concurrent tabs preserve a single exact authorization',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);const saved=await h.page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage)));
 const second=await h.context.newPage();second.setDefaultTimeout(8000);await second.addInitScript(saved=>{for(const [k,v]of Object.entries(saved))sessionStorage.setItem(k,v);},saved);
 await second.goto(h.page.url());await second.waitForFunction(()=>window.AgentBountiesComposer?.review().explicitly_approved);await tool(second,'agent_bounties_open_funding_review');await reconnect({page:second});
 await Promise.all([h.page.getByRole('button',{name:'Continue funding',exact:true}).click(),second.getByRole('button',{name:'Continue funding',exact:true}).click()]);
 await Promise.all([pending(h),pending({page:second})]);
 assert.equal(h.state.signed,1);assert.ok(h.state.relayRequests.length>=2);assert.ok(h.state.relayRequests.length<=3);
 for(const request of h.state.relayRequests)assert.deepEqual(request,h.state.relayRequests[0]);
 assert.equal((await status(h)).public_inventory_verified,false);
 // Same-byte retries are permitted. Real relay idempotency/nonce safety belongs
 // to the separate backend gates; a mocked sponsor cannot prove broadcast count.
});
for(const mobile of [false,true])test(`same-tab sign-in preserves unapproved draft (${mobile?'phone':'desktop'})`,{timeout:25000},async()=>{
 const row={scenario:'same-tab sign-in preserves unapproved draft',viewport:mobile?'phone':'desktop',passed:false};results.push(row);
 const h=await setup({mobile,authenticated:false});try{
  const before=await h.page.evaluate(()=>window.AgentBountiesWorkflow.createClient(window).load());await tool(h.page,'agent_bounties_open_account_setup');await h.page.waitForURL('**/?postReturn=1#login');h.state.authenticated=true;await h.page.reload();await h.page.waitForURL('**/post.html?**');await h.page.waitForFunction(()=>window.AgentBountiesComposer);
  const after=await h.page.evaluate(()=>window.AgentBountiesWorkflow.createClient(window).load());assert.equal(after.id,before.id);
  for(const f of ['title','goal','acceptance_criteria','solver_reward_usdc','verifier_reward_usdc','task_window_days','review_mode','delivery_deadline'])assert.deepEqual(after.draft[f],before.draft[f],f);
  assert.equal(await h.page.evaluate(()=>window.AgentBountiesComposer.review().explicitly_approved),false);assert.equal(h.context.pages().length,1);assert.equal(h.state.signed,0);assert.equal(h.state.relayRequests.length,0);assert.equal(h.state.sent,0);row.passed=true;
 }catch(e){row.error=e.message;throw e;}finally{row.signatures=h.state.signed;row.relay_requests=h.state.relayRequests.length;row.customer_transactions=h.state.sent;await h.context.close();}
});


scenario('changed legal policy after reload blocks saved authorization',{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);h.state.legalChanged=true;await h.page.reload();await h.page.waitForFunction(()=>window.AgentBountiesComposer);
 await tool(h.page,'agent_bounties_open_funding_review');await reconnect(h);await h.page.locator('[data-legal-consent-checkbox]').check();
 await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();await h.page.waitForFunction(()=>document.body.innerText.includes('legal terms changed'));
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});


for(const reload of [false,true])for(const fault of ['legalUnavailable','legalInvalidHash'])scenario(`fresh policy ${fault} blocks retry ${reload?'after reload':'in same tab'} and recovery reuses signature`,{relayStatus:429},async h=>{
 await signFunding(h);await pending(h);const original=h.state.relayRequests[0];h.state[fault]=true;
 if(reload){await h.page.reload();await h.page.waitForFunction(()=>window.AgentBountiesComposer);await tool(h.page,'agent_bounties_open_funding_review');await reconnect(h);await h.page.locator('[data-legal-consent-checkbox]').check();}
 await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();await pending(h);
 assert.equal(h.state.relayRequests.length,1,'Fresh-policy failure cannot reuse cached hosted success');assert.match(await h.page.locator('body').innerText(),/legal terms changed or could not be checked/);assert.equal(h.state.signed,1);
 h.state[fault]=false;h.state.relayStatus=200;await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();await h.page.waitForURL('**/funded.html?**');
 assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,2);assert.deepEqual(h.state.relayRequests[1],original);
});


scenario('canonical reconciliation finishes despite policy outage without replay',{lostReply:true},async h=>{
 await signFunding(h);await pending(h);h.state.canonical=true;h.state.inventory=true;h.state.legalUnavailable=true;
 await h.page.getByRole('button',{name:'Continue funding',exact:true}).click();await h.page.waitForURL('**/funded.html?**');assert.equal(h.state.signed,1);assert.equal(h.state.relayRequests.length,1);
});
after(async()=>{if(process.env.SPONSORED_EVIDENCE_DIR)await writeFile(path.join(process.env.SPONSORED_EVIDENCE_DIR,'scenarios.json'),JSON.stringify({boundary:'Real local API/PostgreSQL and public-key signatures; simulated wallet transport, sponsor, Base and canonical projections. No live payment or relay.',passed:results.filter(r=>r.passed).length,total:results.length,results},null,2)+'\n');});
