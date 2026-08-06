#!/usr/bin/env bash
# Stepped concurrency probe: fire N simultaneous FAQ turns and count how many
# actually produced an answer. Finds the Azure rate-limit ceiling precisely.
#
# Usage: bash step-concurrency.sh 6 12 20
HOST="${WIDGET_URL:-https://navio-widget.vercel.app}"
OUT="${OUT_DIR:-/tmp/step}"
mkdir -p "$OUT"

for N in "$@"; do
  rm -f "$OUT"/s_*.txt
  for i in $(seq 1 "$N"); do
  (
    R=$(curl -s -X POST "$HOST/eve/v1/session" -H "content-type: application/json" \
        -d "{\"message\":\"Was ist Firmenfitness? (n$N-$i)\"}")
    S=$(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).sessionId)}catch(e){console.log('E')}})")
    T=$(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).continuationToken)}catch(e){console.log('E')}})")
    curl -s --max-time 120 "$HOST/eve/v1/session/$S/stream?continuationToken=$T" > "$OUT/s_$i.txt" 2>/dev/null
  ) &
  done
  wait

  ok=0; fail=0; ratelimit=0
  for i in $(seq 1 "$N"); do
    f="$OUT/s_$i.txt"
    if grep -q 'message.appended' "$f" 2>/dev/null; then
      ok=$((ok+1))
    else
      fail=$((fail+1))
      grep -q 'exceeded rate limit' "$f" 2>/dev/null && ratelimit=$((ratelimit+1))
    fi
  done
  pct=$(( fail * 100 / N ))
  echo "  concurrency=${N}: ok=${ok} fail=${fail} (${pct}%) rate_limited=${ratelimit}"
  sleep 20   # let the quota window drain between steps
done
