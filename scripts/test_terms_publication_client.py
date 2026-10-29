import hashlib
import json
import os
import unittest
from unittest.mock import patch
import terms_publication_client as client

ADDRESS = '0x' + '11' * 20
TOKEN = 'abws_' + 'a' * 64
DOCUMENT = {'contract_terms': {'network':'base-mainnet','creator_wallet':ADDRESS}, 'title':'Expected',
            'verification_policy':{}, 'acceptance_criteria':['deliver'], 'benchmark':{}, 'evidence_schema':{}}


def record(document=DOCUMENT):
    from _shared.evm import keccak256
    result = {'creator_wallet':ADDRESS,'document':document}
    for field, value in [('terms_hash',document),('policy_hash',document['verification_policy']),('acceptance_criteria_hash',document['acceptance_criteria']),('benchmark_hash',document['benchmark']),('evidence_schema_hash',document['evidence_schema'])]:
        result[field]=keccak256(client.canonical(value))
    return result


class PublicationClientTests(unittest.TestCase):
    def test_missing_or_operator_identity_stops_before_publication(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(client, 'request') as send:
            with self.assertRaisesRegex(client.PublicationError, 'verified creator'):
                client.publish_terms('https://api.agentizable.ai', ADDRESS, DOCUMENT)
            send.assert_not_called()
        for principal in [{'kind':'operator'}, {'kind':'wallet','chain_id':84532,'address':ADDRESS},
                          {'kind':'wallet','chain_id':8453,'address':'0x'+'22'*20}]:
            with patch.dict(os.environ, {'TERMS_CREATOR_SESSION_TOKEN':TOKEN}), patch.object(client, 'request',return_value=(200,{'principal':principal})) as send:
                with self.assertRaisesRegex(client.PublicationError,'exact creator'):
                    client.publish_terms('https://api.agentizable.ai',ADDRESS,DOCUMENT)
                self.assertEqual(send.call_count,1)

    def test_success_preserves_key_and_exact_body_across_retries(self):
        calls=[]
        def send(api,path,token,body=None,key=None):
            calls.append((path,token,body,key))
            return (200,{'principal':{'kind':'wallet','address':ADDRESS,'chain_id':8453}}) if path=='/v1/auth/session' else (200,record())
        with patch.dict(os.environ, {'TERMS_CREATOR_SESSION_TOKEN':TOKEN}),patch.object(client,'request',side_effect=send):
            self.assertEqual(client.publish_terms('https://api.agentizable.ai',ADDRESS,DOCUMENT),record())
            client.publish_terms('https://api.agentizable.ai',ADDRESS,DOCUMENT)
        self.assertEqual(calls[1],calls[3])
        self.assertEqual(calls[1][3],'activation-terms-v1-'+hashlib.sha256(client.canonical(calls[1][2])).hexdigest())

    def test_existing_exact_record_always_stops_without_funding_continuation(self):
        path='/v1/base/autonomous-bounties/terms/'+record()['terms_hash']
        responses=[(200,{'principal':{'kind':'wallet','address':ADDRESS,'chain_id':8453}}),
                   (409,{'error_code':'publication_already_exists','next_action_url':path}),(200,record())]
        with patch.dict(os.environ, {'TERMS_CREATOR_SESSION_TOKEN':TOKEN}),patch.object(client,'request',side_effect=responses) as send:
            with self.assertRaisesRegex(client.PublicationError,'No automatic signing or funding'):
                client.publish_terms('https://api.agentizable.ai',ADDRESS,DOCUMENT)
            self.assertEqual(send.call_count,3)

    def test_wrong_content_and_hash_fail_before_use(self):
        for changed in [{**record(),'creator_wallet':'0x'+'22'*20},{**record(),'document':{**DOCUMENT,'title':'Changed'}},
                        *[{**record(),field:'0x'+'00'*32} for field in ['terms_hash','policy_hash','acceptance_criteria_hash','benchmark_hash','evidence_schema_hash']]]:
            with self.assertRaises(client.PublicationError): client.validate_record(changed,ADDRESS,DOCUMENT)

    def test_destination_allowlist_redirects_and_error_redaction(self):
        for api in ['https://evil.test','https://api.agentizable.ai.evil.test','https://user:secret@api.agentizable.ai','https://api.agentizable.ai/path','https://api.agentizable.ai?secret=123']:
            with self.assertRaises(client.PublicationError): client.origin(api)
        self.assertIsNone(client.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.test'))
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect=OSError('sensitive URL token')
            with self.assertRaises(client.PublicationError) as raised: client.request('https://api.agentizable.ai','/test',TOKEN)
            self.assertNotIn('sensitive',str(raised.exception));self.assertNotIn(TOKEN,str(raised.exception))


    def test_all_activation_entrypoints_guard_before_transaction_work(self):
        from pathlib import Path
        import ast
        for name,entry in [('activate_standing_meta_v3_replacements.py','activate'),('activate_routed_v3_replacements.py','activate'),('activate_direct_growth_v2.py','activate'),('durable_verifier_router_deploy.py','deploy')]:
            tree=ast.parse(Path(__file__).with_name(name).read_text())
            function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==entry)
            calls=[node for node in ast.walk(function) if isinstance(node,ast.Call)]
            guard=next(node for node in calls if isinstance(node.func,ast.Attribute) and node.func.attr=='require_creator_session')
            mutations=[node for node in calls if isinstance(node.func,ast.Name) and node.func.id in ('deploy_singleton','create_if_missing','submit_action')]
            self.assertTrue(all(guard.lineno<node.lineno for node in mutations))

if __name__=='__main__':unittest.main()
