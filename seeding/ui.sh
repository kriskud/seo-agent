#!/usr/bin/env bash
# Поднимает весь UI сидинга одной командой (запускать на маке):
#   1) вьюеры review.mjs на vps2 (drill :8787, floprooms :8788), если упали;
#   2) ssh-туннели с мака до них, если умерли;
#   3) проверяет оба адреса и печатает итог.
# Установлено как ~/.local/bin/seeding-ui (симлинк на этот файл).
set -u

echo "Проверяю вьюеры на vps2…"
ssh vps2 'cd ~/projects/seo-agent
for pair in "drill 8787" "floprooms 8788"; do
  set -- $pair
  if ! curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$2/"; then
    echo "  $1: не отвечает — запускаю"
    (setsid nohup node seeding/review.mjs --project "$1" --port "$2" >"/tmp/review-$1.log" 2>&1 </dev/null &)
  fi
done
sleep 1' || { echo "ssh до vps2 не прошёл — проверь сеть"; exit 1; }

echo "Проверяю туннели…"
for port in 8787 8788; do
  if ! curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$port/"; then
    # Живой процесс-туннель с мёртвым соединением мешает новому — убираем.
    pkill -f "ssh.*-L $port:127.0.0.1:$port" 2>/dev/null
    sleep 0.3
    ssh -f -N -o ExitOnForwardFailure=yes -L "$port:127.0.0.1:$port" vps2
  fi
done

ok=0
for pair in "drill 8787" "floprooms 8788"; do
  set -- $pair
  code=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "http://127.0.0.1:$2/" || true)
  if [ "$code" = 200 ]; then
    echo "✓ $1: http://127.0.0.1:$2"
  else
    echo "✗ $1 не поднялся (HTTP $code) — лог: ssh vps2 tail /tmp/review-$1.log"
    ok=1
  fi
done
exit $ok
