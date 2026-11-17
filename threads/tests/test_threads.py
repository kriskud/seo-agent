import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from threads import config, db, discover, generate, llm, publish, schedule
from threads.threads_api import ThreadsApiError

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)


def make_account(tmp, **over):
    d = Path(tmp) / "acc"
    d.mkdir(exist_ok=True)
    data = {"brand": "B", "language": "en", "status": "active", "website_url": "https://b.example",
            "audience": "a", "timezone": "UTC", "posts_per_day": 1, "slots": ["09:00", "18:00"],
            "weekdays": [1, 2, 3, 4, 5, 6, 7], "tracking": {"utm_source": "threads"},
            "search": {"queries": ["q1", "q2", "q3"], "per_day": 2, "min_score": 70}}
    data.update(over)
    (d / "account.json").write_text(json.dumps(data))
    (d / "examples.md").write_text("\n---\n".join(f"example number {i} about zebras" for i in range(5)))
    (d / "banned.txt").write_text("game-changer\n")
    return config.Account(d)


class FakeClient:
    def __init__(self, fail_publish=None, existing=()):
        self.fail_publish, self.posts, self.published = fail_publish, list(existing), 0

    def create_text_container(self, text):
        self.text = text
        return "c1"

    def container_status(self, cid):
        return {"status": "FINISHED"}

    def publish(self, cid):
        if self.fail_publish:
            raise self.fail_publish
        self.published += 1
        self.posts.append({"id": "t1", "text": self.text, "permalink": "https://t/1"})
        return "t1"

    def post_info(self, pid):
        return {"permalink": "https://t/1"}

    def recent_posts(self, limit=25):
        return self.posts


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.con = db.connect(Path(self.tmp.name) / "t.db")
        self.addCleanup(self.con.close)
        self.acc = make_account(self.tmp.name)
        patcher = mock.patch("threads.publish.notify_owner")
        self.notify = patcher.start()
        self.addCleanup(patcher.stop)

    def add_post(self, text="hello there", when=NOW - timedelta(minutes=5), status="scheduled", key="k1"):
        cur = self.con.execute(
            "INSERT INTO threads_posts (account, text, status, slot_key, scheduled_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)", (self.acc.id, text, status, key, db.fmt_ts(when), db.utcnow()))
        self.con.commit()
        return cur.lastrowid

    def status(self, pid):
        return self.con.execute("SELECT status FROM threads_posts WHERE id = ?", (pid,)).fetchone()["status"]


class ScheduleTest(Base):
    def test_one_slot_per_day_in_future(self):
        slots = schedule.upcoming_slots(self.acc, NOW, 3)
        self.assertEqual(len({k[:10] for k, _ in slots}), len(slots))
        self.assertTrue(all(NOW < when <= NOW + timedelta(days=3) for _, when in slots))
        self.assertEqual(slots, schedule.upcoming_slots(self.acc, NOW, 3))  # джиттер детерминирован

    def test_weekdays_respected(self):
        acc = make_account(self.tmp.name, weekdays=[3])  # только среда; NOW — вторник
        self.assertEqual([k[:10] for k, _ in schedule.upcoming_slots(acc, NOW, 3)], ["2026-10-14"])

    def test_taken_slot_is_not_free(self):
        key, when = schedule.upcoming_slots(self.acc, NOW, 3)[0]
        self.add_post(when=when, key=key)
        self.assertNotIn(key, [k for k, _ in schedule.free_slots(self.con, self.acc, NOW, 3)])

    def test_slot_is_unique_in_db(self):
        self.add_post(key="same")
        with self.assertRaises(Exception):
            self.add_post(key="same")


class ValidateTest(Base):
    def test_rules(self):
        v = lambda t, recent=(): generate.validate(t, self.acc, list(recent))
        self.assertIsNone(v("How do you keep treatment notes?"))
        self.assertIn("длиннее", v("x" * 501))
        self.assertIn("ссылка", v("try cosmodesk.online today"))
        self.assertIn("хэштег", v("great #skincare"))
        self.assertIn("запрещённый", v("a real Game-Changer"))
        self.assertIn("похож", v("How do you keep treatment notes?", ["How do you keep treatment notes"]))

    def test_refill_fills_free_slots_once(self):
        posts = [{"rubric": "question", "text": t} for t in (
            "Where do treatment notes live in your studio?",
            "Somebody cancelled twenty minutes before a facial again.",
            "Counting serum bottles by hand every Friday sounds exhausting.",
            "I shipped onboarding last week and immediately found three bugs.",
            "Paper intake forms: charming or a filing nightmare?")]
        with mock.patch("threads.llm.call_json", return_value={"posts": posts}) as call:
            n = generate.refill(self.con, self.acc, NOW)
            self.assertEqual(n, len(schedule.upcoming_slots(self.acc, NOW, config.QUEUE_DAYS)))
            self.assertEqual(generate.refill(self.con, self.acc, NOW), 0)  # слоты заняты
            self.assertEqual(call.call_count, 1)

    def test_refill_does_not_loop_when_generation_yields_nothing(self):
        with mock.patch("threads.llm.call_json", return_value={"posts": []}) as call:
            generate.refill(self.con, self.acc, NOW)
            generate.refill(self.con, self.acc, NOW + timedelta(minutes=1))
            self.assertEqual(call.call_count, 1)


class PublishTest(Base):
    def run_publish(self, client):
        return publish.publish_due(self.con, self.acc, NOW, client=client, sleep=lambda s: None)

    def test_publishes_due_post_once(self):
        pid, client = self.add_post(), FakeClient()
        self.assertEqual(self.run_publish(client), 1)
        self.assertEqual(self.run_publish(client), 0)
        self.assertEqual((self.status(pid), client.published), ("published", 1))

    def test_future_post_waits(self):
        pid = self.add_post(when=NOW + timedelta(hours=1))
        self.assertEqual(self.run_publish(FakeClient()), 0)
        self.assertEqual(self.status(pid), "scheduled")

    def test_unknown_outcome_but_post_exists_is_not_republished(self):
        pid = self.add_post(text="hello there")
        client = FakeClient(fail_publish=ThreadsApiError(0, "timeout"),
                            existing=[{"id": "t9", "text": "hello there", "permalink": "p"}])
        self.run_publish(client)
        self.assertEqual(self.status(pid), "published")

    def test_failure_retries_then_fails_and_notifies(self):
        pid, client = self.add_post(), FakeClient(fail_publish=ThreadsApiError(400, "bad"))
        for i in range(publish.MAX_ATTEMPTS):
            publish.publish_due(self.con, self.acc, NOW + timedelta(hours=i), client=client, sleep=lambda s: None)
        self.assertEqual(self.status(pid), "failed")
        self.notify.assert_called_once()

    def test_crash_during_publish_is_reconciled(self):
        done = self.add_post(text="went out", status="publishing", key="a")
        lost = self.add_post(text="never left", status="publishing", key="b")
        self.run_publish(FakeClient(existing=[{"id": "t5", "text": "went out"}]))
        self.assertEqual((self.status(done), self.status(lost)), ("published", "scheduled"))

    def test_stale_post_is_moved_not_published(self):
        pid, client = self.add_post(when=NOW - timedelta(hours=10)), FakeClient()
        self.assertEqual(self.run_publish(client), 0)
        row = self.con.execute("SELECT * FROM threads_posts WHERE id = ?", (pid,)).fetchone()
        self.assertEqual(row["status"], "scheduled")
        self.assertGreater(db.parse_ts(row["scheduled_at"]), NOW)

    def test_expired_token_alerts_and_keeps_post(self):
        pid = self.add_post()
        self.run_publish(FakeClient(fail_publish=ThreadsApiError(401, '{"error":{"code":190}}')))
        self.assertEqual(self.status(pid), "scheduled")
        self.notify.assert_called_once()

    def test_paused_account_is_not_running(self):
        self.assertTrue(db.is_running(self.con, self.acc))
        db.set_state(self.con, "paused_all", "1")
        self.assertFalse(db.is_running(self.con, self.acc))
        self.assertFalse(db.is_running(self.con, make_account(self.tmp.name, status="draft")))


class DiscoverTest(Base):
    def test_normalize(self):
        self.assertEqual(discover.normalize("https://www.threads.net/@Jane.Doe/post/DAbc-1?x=1"),
                         ("https://www.threads.com/@Jane.Doe/post/DAbc-1", "jane.doe"))
        self.assertIsNone(discover.normalize("https://www.threads.com/@jane"))
        self.assertIsNone(discover.normalize("https://example.com/@a/post/1"))

    def test_discover_dedupes_and_rotates_queries(self):
        seen = []

        def fake_search(query, account, session=None):
            seen.append(query)
            return [{"link": "https://www.threads.net/@a/post/1", "title": "t", "snippet": "s"},
                    {"link": "https://www.threads.com/@a/post/1"}, {"link": "https://x.com/y"}]

        with mock.patch.object(config, "SERPER_API_KEY", "k"), mock.patch("threads.discover.search", fake_search):
            self.assertEqual(discover.discover(self.con, self.acc), 1)
            self.assertEqual(discover.discover(self.con, self.acc), 0)
        self.assertEqual(seen, ["q1", "q2", "q3", "q1"])

    def test_qualify_drafts_only_above_threshold(self):
        for i in (1, 2):
            self.con.execute("INSERT INTO threads_leads (account, url, author, found_at, updated_at) "
                             "VALUES (?, ?, 'a', ?, ?)", (self.acc.id, f"u{i}", db.utcnow(), db.utcnow()))
        answer = {"leads": [{"id": 1, "score": 85, "reason": "r", "reply": "useful reply"},
                            {"id": 2, "score": 40, "reason": "r", "reply": "should be dropped"}]}
        with mock.patch("threads.llm.call_json", return_value=answer):
            self.assertEqual(discover.qualify(self.con, self.acc), 1)
        rows = {r["id"]: r for r in self.con.execute("SELECT * FROM threads_leads")}
        self.assertEqual((rows[1]["status"], rows[1]["draft"]), ("drafted", "useful reply"))
        self.assertEqual((rows[2]["status"], rows[2]["draft"]), ("rejected", None))


class BudgetTest(Base):
    def test_budget_blocks_call(self):
        self.con.execute("INSERT INTO threads_llm_usage (ts, cost_usd) VALUES (?, ?)",
                         (db.utcnow(), config.LLM_MONTHLY_BUDGET_USD))
        with self.assertRaises(llm.BudgetExceeded):
            llm.call_json(self.con, "a", "p", "s", "u", {}, client=mock.Mock())


class AccountsTest(unittest.TestCase):
    def test_real_accounts_load(self):
        accounts = config.load_accounts()
        self.assertIn("cosmodesk_en", accounts)
        self.assertIn("utm_campaign=cosmodesk_en", accounts["cosmodesk_en"].tracked_url())
        for acc in accounts.values():
            for ex in acc.examples:
                self.assertLessEqual(len(ex), config.MAX_POST_LEN)


if __name__ == "__main__":
    unittest.main()
