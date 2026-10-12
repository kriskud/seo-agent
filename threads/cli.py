"""Ручные команды для проверки без Telegram.

  python -m threads.cli accounts
  python -m threads.cli gen <account> [N]        напечатать N постов, в очередь не ставить
  python -m threads.cli refill <account>          заполнить очередь
  python -m threads.cli queue [account]
  python -m threads.cli discover <account>        поиск + оценка, без отправки в Telegram
  python -m threads.cli report <account>
  python -m threads.cli tick                      один проход демона
"""
import sys

from . import config, db, discover, generate, metrics, run


def main():
    config.setup_logging()
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    accounts = config.load_accounts()
    con = db.connect()
    cmd, acc = args[0], accounts.get(args[1]) if len(args) > 1 else None
    if cmd == "accounts":
        for a in accounts.values():
            auth = db.get_auth(con, a.id)
            print(f"{a.id}: {a['status']}, токен {'есть' if auth else 'нет'}, "
                  f"эталонов {len(a.examples)}, ссылка для био {a.tracked_url()}")
    elif cmd == "tick":
        run.tick(con, accounts)
    elif cmd == "queue":
        for r in con.execute("SELECT * FROM threads_posts WHERE status = 'scheduled' ORDER BY scheduled_at"):
            if not acc or r["account"] == acc.id:
                print(f"\n№{r['id']} {r['account']} {r['scheduled_at']} [{r['rubric']}]\n{r['text']}")
    elif not acc:
        sys.exit(f"Нужен аккаунт: {' | '.join(accounts)}")
    elif cmd == "gen":
        for p in generate.generate(con, acc, int(args[2]) if len(args) > 2 else 5):
            print(f"\n[{p['rubric']}] ({len(p['text'])})\n{p['text']}")
    elif cmd == "refill":
        print("добавлено:", generate.refill(con, acc, force=True))
    elif cmd == "discover":
        print("найдено:", discover.discover(con, acc), "· черновиков:", discover.qualify(con, acc))
        for r in con.execute("SELECT * FROM threads_leads WHERE account = ? AND status = 'drafted' "
                             "ORDER BY score DESC", (acc.id,)):
            print(f"\n{r['score']} {r['url']}\n  {r['reason']}\n  → {r['draft']}")
    elif cmd == "report":
        print(metrics.report(con, acc))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
