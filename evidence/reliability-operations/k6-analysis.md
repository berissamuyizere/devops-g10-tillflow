# G3 k6 analysis — public pay envelope

**When:** 2026-09-20 19:53–20:15 EAT (22m00s)  
**Who:** Saloi  
**Edge:** `https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com` only. No `/internal/*`. Fake M-Pesa. Payer `254700000000`.  
**Script:** [`k6/g3-load.js`](k6/g3-load.js) `SCENARIO=full`  
**Export:** [`k6-g3-full.json`](k6-g3-full.json) · transcript [`k6-g3-full.txt`](k6-g3-full.txt)

WAF `RateLimitExceptCallback` was **200 → 2000** at 19:52 EAT, then **2000 → 200** at 20:15 EAT the same evening. Verified `waf_now=200`. Do not leave 2000 up.

## Envelope

| Phase | Shape | Result |
|---|---|---|
| Smoke | 1 VU × 5 iter | 5/5 in 6.3s |
| Baseline | ramp 1 → 2 iter/s over 4 min | held |
| Spike | 6 iter/s × 30s | held |
| Soak | **2 iter/s × 15 min** | held |

Each iteration is sale → pay → signed callback → GET sale. Callback is WAF-exempt. Counted toward the IP limit: sale + pay + GET.

## Highest sustained rps

**2 paid-sale flows / s for 15 minutes** (soak). That is ~6 WAF-counted rps plus callbacks.

Across the whole 22 min run:

| | Value |
|---|---|
| Iterations | 2374 (1.80 / s) |
| HTTP reqs | 9496 (7.19 / s) |
| Checks | 9494 / 9496 (99.97%) |
| `http_req_failed` | 1 / 9496 (0.01%) |
| HTTP p95 | **253 ms** (threshold 2000 ms) |
| HTTP max | 754 ms |
| Iteration p95 | 969 ms |

Brief requires failures under 1% (got **0.01%**), p95 under 500 ms (got **253 ms**), checks over 99% (got **99.97%**). The script’s own HTTP p95 threshold was 2000 ms; the brief is the bar Rob will use.

Spike at 6 iter/s (~18 counted rps) for 30s did not move p95 out of the 250 ms band. Pay stayed `accepted` on **2374 / 2374**. One callback + one “sale is paid” miss (same iteration). Arsema not needed.

## Bottleneck

Not CPU and not WAF (window was 2000).

- POS CPU: idle ~1.3% → soak ~6%, **peak 17%** (one minute 11.7% average).
- Payments CPU: idle ~1.1% → soak ~4%, **peak 10%**.
- Desired count stayed **POS 2 / Payments 2**. Y6 70% tracking did not scale out.
- Each hop is ~220 ms. The iteration is four sequential public calls, so wall time is ~890 ms even though no single request is slow.
- GET `/sales/:id` is cache-aside. This script always GETs a **new** sale once, so the cache cannot help.

Standing production limiter is still WAF **200 req / 5 min / IP** (~0.67 counted rps). Real soak is impossible at that cap.

## Headroom

At 2 iter/s soak, POS sat around 12–17% vs a **70%** scale target. Linear CPU guess: ~4× this soak before POS approaches 70% (~8 iter/s), Payments even more. That is only a guess — we did not hold 8 iter/s. Spike 6 iter/s for 30s was fine; a longer run at that rate is the next test, not a claim.

API Gateway throttle (burst 200 / rate 100) was not the ceiling at this envelope.

## Cost

Tasks stayed at desired: POS 2, Payments 2, Web 2, Commission 1. Each task is Fargate Linux/ARM **0.5 vCPU / 1 GB** (`eu-central-1`).

Using Frankfurt ARM list rates (~Aug 2026): **$0.03725 / vCPU-h** and **$0.00409 / GB-h**.

| | Arithmetic | USD / hour |
|---|---|---|
| 7 × 0.5 vCPU | 3.5 × 0.03725 | 0.130 |
| 7 × 1 GB | 7 × 0.00409 | 0.029 |
| App compute now | | **~0.16** |
| Extra if POS+Payments 2→4 | +2 +2 tasks | **+~0.09** |

The 22 min soak **did not add tasks**. Incremental Fargate compute for the test is ~$0. ALB/API GW request charges for 9.5k calls are cents. Leaving WAF at 2000 would not change compute; it would only widen the public abuse window — that is why it went back to 200.

## Cache before / after

`pos_cache_requests_total` on `GET /sales/:id` (EMF `OTelLib=tillflow.pos`).

| | Before (idle) | During / after k6 (30 min) |
|---|---|---|
| hit | 0 | **0** |
| miss | 0 | **2291** |
| error | 0 | **0** |

Hit rate 0% is expected: 2374 unique sales, one GET each, first read after write. Cache is working as miss-then-set; this path does not prove a hit-rate win. A repeat-GET scenario would.

Snapshots: [`k6-before-metrics.txt`](k6-before-metrics.txt), [`k6-after-metrics.txt`](k6-after-metrics.txt).
