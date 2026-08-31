import unittest

from providers.base import extract_state
from providers.property_tax import resolve_policy


class PropertyTaxPolicyTests(unittest.TestCase):
    def test_california_uses_prop_13_and_resets_on_sale(self):
        policy = resolve_policy("ca")
        self.assertEqual(policy["model"], "assessed_value_cap")
        self.assertEqual(policy["annual_cap_pct"], 2.0)
        self.assertTrue(policy["reassesses_on_sale"])
        self.assertEqual(policy["coverage"], "verified_state_rule")

    def test_oregon_cap_does_not_reset_merely_on_sale(self):
        policy = resolve_policy("OR")
        self.assertEqual(policy["annual_cap_pct"], 3.0)
        self.assertFalse(policy["reassesses_on_sale"])

    def test_nevada_caps_the_bill_for_investment_property(self):
        policy = resolve_policy("NV")
        self.assertEqual(policy["model"], "tax_bill_cap")
        self.assertEqual(policy["annual_cap_pct"], 8.0)

    def test_unverified_state_uses_explicit_general_model(self):
        policy = resolve_policy("VA")
        self.assertEqual(policy["model"], "market_value")
        self.assertEqual(policy["coverage"], "general")
        self.assertIsNone(policy["source_url"])

    def test_state_resolution_accepts_case_and_full_names(self):
        self.assertEqual(extract_state("123 Main St, los angeles, ca 90001"), "CA")
        self.assertEqual(extract_state("123 Main St, Los Angeles, California 90001"), "CA")


if __name__ == "__main__":
    unittest.main()
