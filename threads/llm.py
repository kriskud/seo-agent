"""Единственная точка вызова LLM: структурированный ответ, учёт расходов, месячный потолок."""
import json
import logging
from datetime import datetime, timezone

import anthropic

from . import config, db

log = logging.getLogger("threads.llm")

# $ за 1 млн токенов (вход, выход). Неизвестная модель считается по самой дорогой строке,
# чтобы потолок бюджета срабатывал раньше, а не позже.
PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-opus-5": (5.0, 25.0),
}
_FALLBACK_PRICE = (10.0, 50.0)


class LlmError(Exception):
    pass


class BudgetExceeded(LlmError):
    pass


def month_spend(con):
    start = datetime.now(timezone.utc).strftime("%Y-%m-01T00:00:00Z")
    row = con.execute("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM threads_llm_usage WHERE ts >= ?",
                      (start,)).fetchone()
    return row["s"]


def call_json(con, account, purpose, system, user, schema, client=None):
    """Один запрос к модели; ответ — объект по JSON-схеме. Расход пишется в threads_llm_usage."""
    spent = month_spend(con)
    if spent >= config.LLM_MONTHLY_BUDGET_USD:
        raise BudgetExceeded(f"месячный бюджет на AI исчерпан: ${spent:.2f} из "
                             f"${config.LLM_MONTHLY_BUDGET_USD:.2f}")
    client = client or anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY or None)
    try:
        res = client.messages.create(
            model=config.LLM_MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.APIError as e:
        raise LlmError(f"{type(e).__name__}: {config.mask(str(e), config.ANTHROPIC_API_KEY)[:300]}") from e

    pin, pout = PRICES.get(config.LLM_MODEL, _FALLBACK_PRICE)
    cost = (res.usage.input_tokens * pin + res.usage.output_tokens * pout) / 1e6
    con.execute(
        "INSERT INTO threads_llm_usage (ts, account, purpose, model, input_tokens, output_tokens, cost_usd) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (db.utcnow(), account, purpose, config.LLM_MODEL,
         res.usage.input_tokens, res.usage.output_tokens, cost))
    con.commit()

    if res.stop_reason != "end_turn":
        raise LlmError(f"модель остановилась с {res.stop_reason}")
    text = next((b.text for b in res.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError as e:
        raise LlmError("модель вернула не JSON") from e
