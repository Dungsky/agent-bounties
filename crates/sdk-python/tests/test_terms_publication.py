import json
import unittest
from unittest.mock import patch
import httpx
from eth_hash.auto import keccak
from agent_bounties.client import AgentBountiesClient, AgentBountiesHttpError

ADDRESS='0x'+'11'*20
DOCUMENT={'title':'Expected','verification_policy':{},'acceptance_criteria':['deliver'],'benchmark':{},'evidence_schema':{}}

def record():
    document={'source_url':None,'discovery_source':None,**DOCUMENT}
    result={'creator_wallet':ADDRESS,'document':document}
    for key,value in [('terms_hash',document),('policy_hash',{}),('acceptance_criteria_hash',['deliver']),('benchmark_hash',{}),('evidence_schema_hash',{})]:
        result[key]='0x'+keccak(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hex()
    return result

class TermsPublicationTests(unittest.TestCase):
    def test_requires_stable_key_and_preserves_session_and_structured_conflict(self):
        calls=[]
        def handle(request):
            calls.append(request)
            return httpx.Response(409,json={'error_code':'publication_already_exists','next_action_url':'/v1/base/autonomous-bounties/terms/'+record()['terms_hash']})
        with httpx.Client(transport=httpx.MockTransport(handle)) as transport,patch('agent_bounties.client.httpx.request',side_effect=transport.request):
            client=AgentBountiesClient('https://example.test',session_token='abws_'+'a'*64)
            for key in ['',None,'x\n', 'x'*201]:
                with self.assertRaises(ValueError):client.publish_autonomous_bounty_terms(ADDRESS,DOCUMENT,idempotency_key=key)
            self.assertEqual(calls,[])
            for _ in range(2):
                with self.assertRaises(AgentBountiesHttpError) as error:client.publish_autonomous_bounty_terms(ADDRESS,DOCUMENT,idempotency_key='saved')
                self.assertEqual(error.exception.error_code,'publication_already_exists')
        self.assertEqual(len(calls),2)
        self.assertTrue(all(r.method=='POST' and r.headers['idempotency-key']=='saved' and r.headers['authorization']=='Bearer abws_'+'a'*64 for r in calls))
        self.assertEqual(calls[0].content,calls[1].content)
    def test_explicit_readback_validates_exact_content_hash_and_identity(self):
        client=AgentBountiesClient('https://example.test')
        with patch.object(client,'get_autonomous_bounty_terms',return_value=record()) as get:
            self.assertEqual(client.get_verified_autonomous_bounty_terms(record()['terms_hash'],ADDRESS,DOCUMENT),record());get.assert_called_once()
        for changed in [{**record(),'creator_wallet':'wrong'},{**record(),'document':{**DOCUMENT,'title':'Changed'}},{**record(),'benchmark_hash':'0x'+'00'*32}]:
            with patch.object(client,'get_autonomous_bounty_terms',return_value=changed),self.assertRaises(ValueError):
                client.get_verified_autonomous_bounty_terms(record()['terms_hash'],ADDRESS,DOCUMENT)

    def test_server_shaped_records_match_without_changing_caller_document(self):
        from pathlib import Path
        cases=json.loads((Path(__file__).resolve().parents[3]/'scripts/fixtures/terms-publication-readback.json').read_text())['cases']
        client=AgentBountiesClient('https://example.test')
        for fixture in cases:
            with self.subTest(case=fixture['name']):
                wire=fixture['request'];before=json.dumps(wire)
                with patch.object(client,'get_autonomous_bounty_terms',return_value=fixture['record']) as read:
                    self.assertEqual(client.get_verified_autonomous_bounty_terms(fixture['record']['terms_hash'],wire['creator_wallet'],wire['document']),fixture['record'])
                read.assert_called_once_with(fixture['record']['terms_hash']);self.assertEqual(json.dumps(wire),before)
                for field,value in [('goal','Different'),('unknown_requirement',True),('agent_eligibility',{'unknown_requirement':True}),('claim_coordination',{'waitlist_capacity':None})]:
                    with patch.object(client,'get_autonomous_bounty_terms',return_value=fixture['record']),self.assertRaises(ValueError):
                        client.get_verified_autonomous_bounty_terms(fixture['record']['terms_hash'],wire['creator_wallet'],{**wire['document'],field:value})
