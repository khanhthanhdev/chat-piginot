import unittest

from fastapi.testclient import TestClient

from app.main import app


class McpRouteTests(unittest.TestCase):
    def test_mcp_endpoint_is_mounted(self):
        with TestClient(app) as client:
            response = client.get("/mcp/")

        self.assertNotEqual(response.status_code, 404)
        self.assertIn("Client must accept", response.text)
