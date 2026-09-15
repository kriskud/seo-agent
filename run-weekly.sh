#!/usr/bin/env bash
# Недельный прогон seo-agent: аудит → коллекторы → отчёт.
# Коллекторы не валят прогон целиком: отчёт строится по тому, что собралось.
set -u
cd "$(dirname "$0")"

echo "=== seo-agent weekly run: $(date -Iseconds) ==="
node audit.mjs || echo "audit.mjs failed ($?)"
node collect-gsc.mjs || echo "collect-gsc.mjs failed ($?)"
node collect-ywm.mjs || echo "collect-ywm.mjs failed ($?)"
node indexnow.mjs || echo "indexnow.mjs failed ($?)"
node report.mjs
