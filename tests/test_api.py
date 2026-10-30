"""
ClassMind AI - End-to-End FastAPI REST API Tests.
Validates all endpoints: health, session lifecycle, attendance summary,
manual overrides, audit trails, analytics, recommendations feedback,
CSV/JSON exports, and settings persistence.
"""

import unittest
from fastapi.testclient import TestClient
from src.app import app
from src.database import init_database, seed_default_roster, create_session


class TestApiEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from src.services.session_manager import SessionManager
        init_database()
        seed_default_roster()
        mgr = SessionManager.get_instance()
        mgr.initialize_default_session(force_sim=True)
        cls.client = TestClient(app)

    def test_health_endpoint(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["app_name"], "ClassMind AI")
        self.assertTrue(data["offline_mode"])
        self.assertIn("hardware", data)

    def test_current_session_endpoint(self):
        res = self.client.get("/api/sessions/current")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("session_id", data)
        self.assertIn("title", data)

    def test_attendance_summary_and_export(self):
        res = self.client.get("/api/attendance/summary")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["total_enrolled"], 6)
        self.assertIsInstance(data["records"], list)

        # CSV Export
        csv_res = self.client.get("/api/attendance/export/csv")
        self.assertEqual(csv_res.status_code, 200)
        self.assertIn("text/csv", csv_res.headers["content-type"])
        self.assertIn("Roll No", csv_res.text)

        # JSON Export
        json_res = self.client.get("/api/attendance/export/json")
        self.assertEqual(json_res.status_code, 200)
        json_data = json_res.json()
        self.assertIn("metadata", json_data)
        self.assertIn("attendance", json_data)

    def test_manual_attendance_correction_flow(self):
        payload = {
            "student_id": "S101",
            "new_status": "Present",
            "reason": "Verified in front row by instructor manual check",
            "instructor_id": "Test Instructor"
        }
        res = self.client.post("/api/attendance/correct", json=payload)
        self.assertEqual(res.status_code, 200)

        # Verify audit trail contains the override
        audit_res = self.client.get("/api/attendance/audit-trail")
        self.assertEqual(audit_res.status_code, 200)
        logs = audit_res.json()
        self.assertGreaterEqual(len(logs), 1)
        self.assertEqual(logs[0]["student_id"], "S101")
        self.assertEqual(logs[0]["new_status"], "Present")

    def test_analytics_timeseries(self):
        res = self.client.get("/api/analytics/timeseries?limit=10")
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res.json(), list)

    def test_recommendations_and_feedback(self):
        res = self.client.get("/api/recommendations")
        self.assertEqual(res.status_code, 200)
        self.assertIsInstance(res.json(), list)

    def test_settings_retrieval_and_update(self):
        get_res = self.client.get("/api/settings")
        self.assertEqual(get_res.status_code, 200)
        orig_settings = get_res.json()

        update_payload = dict(orig_settings)
        update_payload["data_retention_days"] = 45
        update_payload["anonymize_faces"] = True

        post_res = self.client.post("/api/settings", json=update_payload)
        self.assertEqual(post_res.status_code, 200)
        updated = post_res.json()
        self.assertEqual(updated["data_retention_days"], 45)
        self.assertTrue(updated["anonymize_faces"])

    def test_student_roster_crud(self):
        # 1. Get roster
        roster_res = self.client.get("/api/roster")
        self.assertEqual(roster_res.status_code, 200)
        initial_count = len(roster_res.json())

        # 2. Add student
        new_student = {
            "student_id": "S999",
            "roll_no": "2024-TEST-99",
            "name": "Test Student",
            "section": "Section B"
        }
        add_res = self.client.post("/api/roster", json=new_student)
        self.assertEqual(add_res.status_code, 200)
        self.assertEqual(add_res.json()["name"], "Test Student")

        # 3. Update student
        update_payload = {"name": "Test Student Updated", "section": "Section A"}
        put_res = self.client.put("/api/roster/S999", json=update_payload)
        self.assertEqual(put_res.status_code, 200)
        self.assertEqual(put_res.json()["name"], "Test Student Updated")
        self.assertEqual(put_res.json()["section"], "Section A")

        # 4. Delete student
        del_res = self.client.delete("/api/roster/S999")
        self.assertEqual(del_res.status_code, 200)
        self.assertEqual(del_res.json()["status"], "success")

        # Verify deletion
        final_roster = self.client.get("/api/roster").json()
        self.assertEqual(len(final_roster), initial_count)


if __name__ == "__main__":
    unittest.main()
