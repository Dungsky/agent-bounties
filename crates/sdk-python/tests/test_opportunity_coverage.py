import unittest
from unittest.mock import patch
import httpx
from agent_bounties.client import AgentBountiesClient

class OpportunityCoverageTests(unittest.TestCase):
    def test_partial_and_unavailable_are_preserved_without_zero_inference(self):
        for coverage, items in [('partial', [{'title': 'Checked work'}]), ('unavailable', [])]:
            payload = {'coverage': coverage, 'coverage_scope': 'inventory_page', 'degraded': True,
                'source_statuses': [{'source_type': 'canonical_base', 'available': False, 'coverage': coverage,
                    'protocol_statuses': [{'protocol':'open-competition-v2-beta3','coverage':'unavailable','item_count':None}]}], 'items': items}
            calls = []
            def handle(request):
                calls.append(request)
                return httpx.Response(200, json=payload)
            with httpx.Client(transport=httpx.MockTransport(handle)) as transport, patch('agent_bounties.client.httpx.request', side_effect=transport.request):
                result = AgentBountiesClient('https://example.test').list_opportunities(opportunity_id='canonical:base-mainnet:0x'+'12'*20)
            self.assertEqual(result, payload)
            self.assertEqual(calls[0].method, 'GET')
            self.assertEqual(calls[0].url.params['opportunity_id'], 'canonical:base-mainnet:0x'+'12'*20)
