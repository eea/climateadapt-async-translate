# How Climate-ADAPT translation works

End-to-end reference for the translation pipeline: what runs, in what order,
where the state lives, how to inspect a live deployment, and what is still
broken.

Written for whoever operates or debugs this next. Every command in
[Live probing](#9-live-probing) is read-only unless it says otherwise.

---

## 1. The problem this solves

Climate-ADAPT publishes content in English and machine-translates it into
**26 target languages**. A full sweep is roughly **5,300 published objects × 26
languages ≈ 137,000 translation units**.

The naive shape — one eTranslation request per (object, language) — fails, and
the reason is not obvious:

> eTranslation enforces a **concurrency** quota of **50 active submissions per
> client**, not a rate limit. "Active" means *submitted but not yet delivered*.
> Anything above 50 is rejected with HTTP 400 / `errorCode=-11200
> QUOTA_EXCEEDED`, and it keeps rejecting until in-flight drops back under the
> quota.

A worker that submits 26 jobs in one second and then waits 10 seconds for
deliveries will blow the budget immediately, and then retry into a wall of
`-11200`. That is what happened in production: thousands of failed jobs, and
some languages silently never translated.

Two facts drive the whole design:

| Fact | Consequence |
|---|---|
| A request listing **N target languages counts as one active submission** | Bundling is a 26× reduction in quota use. |
| eTranslation **delivers each language separately**, one callback per language | The language must come from the callback payload, not from the correlation id. |

Official docs: <https://language-tools.ec.europa.eu/dev-corner/etranslation/rest-v2/rate-limits>

---

## 2. The cast

```
┌──────────┐   queue job    ┌─────────┐   pick up   ┌────────────────┐
│  Plone   │ ─────────────▶ │  Redis  │ ──────────▶ │ async-translate │
│ (CMS)    │                │ (BullMQ)│             │  (this repo)    │
└──────────┘                └─────────┘             └────────┬───────┘
     ▲                                                       │
     │  HTTP views (authenticated                            │ POST to Plone views,
     │  by a shared token)                                   │ which call eTranslation
     └───────────────────────────────────────────────────────┘

                    ┌───────────────────────┐
                    │  volto-blocks-        │  Volto blocks JSON ⇄ HTML
                    │  converter service    │  (eTranslation only speaks HTML)
                    └───────────────────────┘
                              │
                    ┌───────────────────────┐
                    │  eTranslation (EC)    │  async: submit → later, callbacks
                    └───────────────────────┘
```

Why the worker calls *back into* Plone instead of talking to eTranslation
directly for most steps: the eTranslation credentials live in Plone, and the
async service is ClusterIP-only in production, so eTranslation cannot POST to it.
All callbacks land on a Plone view, which re-queues them.

---

## 3. Lifecycle of one translation

Numbered, with the actor for each step.

1. **Editor publishes** an English object (or an admin triggers it by hand —
   see [Triggering by hand](#8-triggering-by-hand)).
2. **Plone** calls `@@tohtml` to render the object's Volto blocks to HTML (via
   the converter service), then queues one BullMQ job **per language** onto
   `etranslation`, job name `call_etranslation`.
   > Plone also stamps these jobs with a **delay** that pushes them to 19:00 if
   > they were queued between 07:00 and 19:00 local time. Set
   > `ETRANSLATION_DISABLE_DAYTIME_DELAY` to bypass it. This delay is computed
   > by the **web** pods, so the flag must be set there, not only on the job
   > executor.
3. **Worker** picks up each `call_etranslation` job. With grouping on it does
   *not* submit — it records the language in a Redis group keyed by object and
   schedules a `submit_group` job delayed by `ETL_GROUP_WINDOW_MS`.
   See `collect_etranslation` in `src/jobs.ts`.
4. **Worker** runs `submit_group`: takes an in-flight slot, generates a
   correlation token, and calls Plone's `@@call-etranslation` **once** with a
   comma-separated `target_lang` list and the `ext_ref` token.
5. **Plone** submits to eTranslation with `targetLanguages` array and
   `externalReference = cca-<16 hex>`, and asks for failure notifications via
   `notifications.failure.http` pointed at `@@translate-failure`.
6. **eTranslation** works asynchronously, then POSTs **one callback per
   delivered language** to Plone's `@@translate-callback`.
7. **Plone** parses the callback, takes `targetLanguage` from it, and queues a
   `save_translated_html` job onto `save_etranslation`.
8. **Worker** runs `save_translated_html` → Plone's `@@save-etranslation`, which
   converts the translated HTML back to Volto blocks and writes the translation
   object.
9. **Worker** releases one language-share of the in-flight slot per distinct
   delivered language. When the last one lands, the slot is freed.

Failure path: if eTranslation reports a language as failed, it POSTs to
`@@translate-failure`, Plone queues `translation_failed`, and the worker
releases the shares for exactly those languages. Without
`notifications.failure.http` there is **no signal at all** — see §6.

---

## 4. The three quota mechanisms

All in this service, all tunable, all off-by-default only for grouping.

### Grouping — 26 requests become 1

Plone still queues one job per language (that part never changed). The worker
folds them into a single eTranslation request.

| Layer | Before | After |
|---|---|---|
| BullMQ jobs on `etranslation` | 26 | 26 (unchanged) |
| eTranslation submissions | 26 | **1** |
| Quota consumed | 26 of 50 | **1 of 50** |

The window is `ETL_GROUP_WINDOW_MS` (default 10 s). Plone queues all 26 jobs in
one request with the *same* delay value, so they arrive together and one window
captures them all.

### In-flight gate — never exceed the quota

`QuotaStore` in `src/store.ts` keeps a Redis zset `cca:inflight:idx` of
submission leases.

- A slot is taken at submit time; if `inFlight >= ETL_MAX_INFLIGHT`, the job is
  requeued rather than submitted.
- A slot is released when the last language of that submission is delivered or
  explicitly failed.
- A slot is **always** reclaimed when the lease (`ETL_LEASE_MS`) expires. This is
  the safety net for languages that never arrive and are never reported.
- A `-11200` opens a circuit breaker (`cca:breaker`) for `ETL_BREAKER_MS` and
  requeues instead of hard-failing the job.

Start at `ETL_MAX_INFLIGHT=10` for a first grouped sweep, raise to 40 once a
sweep is clean. 40, not 50: leave headroom for manual work and retries.

### Skip-unchanged cache — don't pay twice

`cca:done:<sha>` where `sha = sha256(obj_uid + "\0" + html)`. A set of languages
already delivered for byte-identical source HTML, TTL 7 days.

Scoped to the object on purpose. Keying on the HTML hash alone leaked skips
across different objects that happened to render identically.

---

## 5. Correlation and `externalReference`

The id sent to eTranslation is **`cca-<16 hex chars>` — exactly 20 characters**.

It used to be the full object path, which reached **210 characters** on deep
paths and was rejected with `errorCode=-10003
CALLER_INFORMATION_EXTERNAL_REFERENCE_TOO_LONG` (schema limit 200). That single
field caused hundreds of failures.

16 hex chars = 64 bits, which is wide enough that collisions across a full sweep
are not a practical concern.

**The language cannot be encoded in the reference.** All deliveries of a bundled
request share one reference, so the language must come from the callback's
`targetLanguage` field. If a bundled delivery ever arrives without a language,
the save handler **throws rather than guessing** — guessing would write one
language's text into another object.

The correlation record (`cca:corr:<token>`) maps the token back to
`path`, `obj_uid`, `serial_id`, `sha`, `langs` and the eTranslation `request_id`.

---

## 6. Failure handling — and what is still silent

### Handled

| Failure | Response |
|---|---|
| `-11200 QUOTA_EXCEEDED` | Circuit breaker + requeue. Counter `quota_exceeded`. |
| Submission not queued upstream | Counter `not_queued`, requeue with payload. |
| Any unexpected submit error | Requeue **with payload**, bounded by `ETL_SUBMIT_MAX_ATTEMPTS`, backoff `ETL_ERROR_BACKOFF_MS`. |
| Language reported failed by eTranslation | `translation_failed` job releases those shares. Counters `failed_languages`, `failed_requests`. |
| Translation arrives after the source object was edited | Plone's `serial_id` staleness guard refuses the write and the save job fails with `Error in job mismatched serial id`. Correct behaviour — it prevents one revision's text landing under another revision — but the delivered translation is discarded and nothing re-requests it. Observed 60 times in one afternoon of manual editing and re-triggering. |
| Stale job (older than `ETL_STALE_JOB_MAX_AGE_MS`) | Dropped at collect time and at submit time. Counters `dropped_stale_collect`, `dropped_stale`. |
| Failure for an unknown token | Counters `failure_unknown_token`, `failure_unattributed`. |

### Still silent — the open problem

**eTranslation can drop a language without reporting anything.** No callback, no
failure notification, no error in any log. Observed in production: a 26-language
submission delivered 22, with `ro lt pt sv` never arriving, while eTranslation's
own `/status` reported *Normal service*.

There is **no per-request status endpoint** in REST v2 — only `/askTranslate`,
`/getDomains` and a system-wide `/status`. Results arrive exclusively by
callback, so you cannot poll for the missing ones.

Consequence: at ~15% loss, a full sweep silently misses on the order of 20,000
translations, and nothing retries them. The lease releases the *slot*, but the
translation is simply gone.

Candidate fixes, in rough order of cost:

1. **Reconciliation pass** — periodically find objects with missing target
   languages (Plone's `find_untranslated` already does this) and re-queue them.
   Sidesteps needing to know which error codes are retryable.
2. **Retry at lease expiry** — the `:seen` set already records which languages
   arrived, so the unaccounted set is computable.
3. **Classify error codes as retryable / not** — needs a policy that does not
   exist yet.

There is deliberately **no automatic retry of failed languages today**. Failure
is observed, not acted on.

---

## 7. State in Redis

Everything lives under `cca:*` and every key has a TTL. Nothing here is worth
backing up — it is all reconstructible except the in-flight gate, which
self-heals via leases.

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `cca:grp:<obj_url>` | hash | Group being collected for one object | `ETL_GROUP_TTL_SEC` (1 h) |
| `cca:grp:<obj_url>:langs` | set | Languages collected so far | same |
| `cca:grp:<obj_url>:armed` | — | Window already scheduled (exactly-once) | same |
| `cca:corr:<token>` | hash | token → path, obj_uid, serial_id, sha, langs, request_id | `ETL_CORR_TTL_SEC` (1 d) |
| `cca:inflight:<token>` | hash | One submission's lease | `ETL_LEASE_MS` |
| `cca:inflight:<token>:seen` | set | Languages delivered for that submission | — |
| `cca:inflight:idx` | zset | The gate: token → lease-expiry ms | — |
| `cca:done:<sha>` | set | Languages already translated for this exact HTML | 7 d |
| `cca:breaker` | — | Circuit breaker open until | `ETL_BREAKER_MS` |
| `cca:stats` | hash | Counters (see below) | — |

BullMQ's own keys are `bull:<queue>:<state>` — `wait`, `active`, `delayed`,
`failed`, `completed`, `paused`, plus `meta`.

### Counters on `cca:stats`

`groups_scheduled`, `submit_attempts`, `submissions`, `submitted_languages`,
`skipped_by_portal`, `cache_skipped`, `dropped_stale`, `dropped_stale_collect`,
`failed_languages`, `failed_requests`, `failure_unknown_token`,
`failure_unattributed`.

Requeues are counted as `requeued_<reason>`, where reason is one of
`at_capacity`, `breaker`, `quota_exceeded`, `not_queued`, `error`. Note that
`quota_exceeded` and `not_queued` are **also** counted under their own bare
names, so those two events appear twice — once for the classification, once for
the requeue. `submit_attempts` counts every execution including requeues, so
`submissions ≈ submit_attempts - Σ requeued_*`.

Healthy sweep: `submissions ≈ submitted_languages / 26`, `quota_exceeded` near
zero, and `requeued_at_capacity` low. A high `requeued_at_capacity` is not just
wasted work — see the fragmentation wart below.

---

## 8. Triggering by hand

Admin views (all `cmf.ManagePortal`, all CSRF-exempt, so `curl -X POST` works
with a manager token). The UI is at `<any-url>/@@see_folder_objects_view`.

| View | Scope | Languages |
|---|---|---|
| `@@translate-this-async` | one object | **all 26, unconditionally** |
| `@@translate-this-async?language=xx` | one object | that one |
| `@@translate-folder-async` | folder, **recursive** | only the **missing** ones |
| `@@translate-folder-async?language=xx` | folder, recursive | that one, forced |
| `@@translate-missing` | folder, recursive | only missing, **published only**, skips `Image`/`File`/`LRF`/`LIF`/`Subsite`/`FrontpageSlide` |

Worth knowing:

- `@@translate-folder-async` has **no `review_state` filter and no portal_type
  blacklist** — it will queue drafts and binary objects too. `@@translate-missing`
  is the safer bulk entry point.
- "Translate the entire folder" uses `find_untranslated`, so it will **not**
  re-translate anything that already has a translation with a title.
- Clicking `?language=en` queues nothing — `en` is skipped in the loop.

---

## 9. Live probing

The async service is ClusterIP-only — there is no ingress. Reach it by exec'ing
into the pod. In Rancher this is the pod's **Exec** action, or `k9s` → select the
pod → `:` → `sh`. Below, `$NS` is the namespace.

### Is grouping actually on?

The startup banner is authoritative — it reflects the *effective* config after
the guards, not just the env var:

```
Grouping: on (window 10000ms, max in flight 10, lease 900000ms, skip cache on)
```

If it says `off`, check the two guards in `src/index.ts`: grouping is force-
disabled when `etranslation_submit` is missing from `BULL_QUEUE_NAMES_CSV`, or
when `submit_group` is missing from `ENABLED_JOBS`. A silently-disabled gate is
far more dangerous than a broken one.

### The worker's own HTTP surface

```sh
kubectl -n $NS exec deploy/async -- sh -c 'wget -qO- http://127.0.0.1:3000/stats'
```

```json
{"groupingEnabled":true,"inFlight":1,"maxInFlight":10,"leaseMs":900000,
 "breakerOpen":false,
 "counters":{"groups_scheduled":"1","submit_attempts":"1","submissions":"1",
             "submitted_languages":"26"}}
```

Other routes: `/` → redirects to `/ui` (BullBoard), `/dash` (QueueDash),
`/status` (the Redis connection status, not a readiness signal).

### Queue state at a glance

Find the Redis pod first (`kubectl -n $NS get pods | grep redis`), then:

```sh
R=<redis-pod>
for q in etranslation etranslation_submit save_etranslation sync_paths delete_translation; do
  for s in wait active delayed failed completed paused; do
    k="bull:$q:$s"
    t=$(kubectl -n $NS exec $R -- redis-cli TYPE $k)
    [ "$t" = none ] && continue
    n=$( [ "$t" = list ] && kubectl -n $NS exec $R -- redis-cli LLEN $k \
                        || kubectl -n $NS exec $R -- redis-cli ZCARD $k )
    echo "$q $s=$n"
  done
done
```

**Check the paused flag separately — a paused queue is invisible in the UI:**

```sh
kubectl -n $NS exec $R -- redis-cli HGETALL bull:etranslation:meta
```

A paused queue parks jobs in a `bull:etranslation:paused` **list** that grows
silently. Production once accumulated ~89,000 jobs there, which is what pushed
Redis toward its volume limit.

### Follow one submission end to end

```sh
# the gate: one member per in-flight submission, score = lease expiry in ms
kubectl -n $NS exec $R -- redis-cli ZRANGE cca:inflight:idx 0 -1 WITHSCORES

# what that submission asked for
kubectl -n $NS exec $R -- redis-cli HGETALL cca:corr:<token>

# which languages actually arrived
kubectl -n $NS exec $R -- redis-cli SMEMBERS cca:inflight:<token>:seen

# what is still outstanding = corr.langs minus :seen
```

The structured log lines are greppable:

```sh
kubectl -n $NS logs deploy/async --since=30m | grep -E "event=etl\.(delivered|failed|quota_backoff)"
```

```
event=etl.delivered token=<token> language=tr remaining=7
event=etl.failed    token=... langs=... 
```

`remaining` counts down per **distinct language**, not per delivery — a
duplicate callback does not double-decrement.

### Is eTranslation itself healthy?

There is no per-request status endpoint, but the system status is public-ish and
worth checking before blaming the pipeline:

```sh
curl -s "https://language-tools.ec.europa.eu/etranslation/api/status"
# {"level":0,"message":"Normal service"}   0 normal · 1 heavy · 2 critical · 3 blocked
```

`level: 0` plus missing languages means the languages were dropped, not delayed.

### Reading a job's payload

BullMQ zset members are job **ids**, not payloads:

```sh
kubectl -n $NS exec $R -- redis-cli ZRANGE bull:etranslation:delayed 0 -1
kubectl -n $NS exec $R -- redis-cli HGET bull:etranslation:<id> data
kubectl -n $NS exec $R -- redis-cli HGET bull:etranslation:<id> opts   # {"delay":...,"attempts":...}
```

`opts.delay` tells you whether the daytime-delay window is still in play.

### Purging safely

Use BullMQ, never raw `DEL` — raw deletes orphan the job hashes:

```js
const { Queue } = require("bullmq");
await new Queue("etranslation", { connection: { host: "redis" } })
  .obliterate({ force: true, count: 1000 });
```

Two traps, both of which have already happened:

1. **`obliterate` can drop the queue `meta` hash, including the `paused` flag.**
   Losing it silently resumes submissions. Re-assert `queue.pause(true)` after.
2. **A pre-purge `dump.rdb` on the volume will resurrect everything on pod
   restart.** Run `redis-cli BGSAVE` *after* purging so the on-disk snapshot
   matches the purged state.

To resume: `queue.resume()`, not `HDEL ... paused`.

---

## 10. Throughput reality

Submissions are no longer the bottleneck. **Saving is.**

- Bundled submissions at `ETL_MAX_INFLIGHT=40`: ~160 submissions/min → a full
  sweep of submissions in ~33 minutes.
- But `save_etranslation` runs at **concurrency 1**, and each save is a real
  Plone write (blocks HTML → Volto JSON → ZODB/RelStorage). Median gap ~480 ms
  → ~90,000 saves/night.
- A full sweep needs ~137,000 saves ≈ **18 hours**, against a 12-hour night
  window.

Options, none implemented yet: batch saves per object, raise save concurrency
with a per-object lock, or widen the window. **Measure on a real sweep before
choosing.**

Also note: 26 concurrent saves to one object can conflict with a simultaneous
user edit under RelStorage. Pre-existing, guarded by a `serial_id` check, and
not caused by bundling (saves are serialised at concurrency 1).

---

## 11. Configuration

| Variable | Default | Notes |
|---|---|---|
| `ETL_GROUPING_ENABLED` | `false` | Master switch. Needs the matching Plone change (§12). |
| `ETL_MAX_INFLIGHT` | `40` | Keep under 50. Start at 10, raise after a clean sweep. |
| `ETL_GROUP_WINDOW_MS` | `10000` | Collection window per object. |
| `ETL_LEASE_MS` | `900000` | Slot reclaim timeout. Can drop to 2–3 min once failure notifications are confirmed working. |
| `ETL_BREAKER_MS` | `30000` | Intake pause after `-11200`. |
| `ETL_SKIP_CACHE` | `true` | Skip already-translated languages for identical HTML. |
| `ETL_SKIP_CACHE_TTL_SEC` | `604800` | 7 days. |
| `ETL_CORR_TTL_SEC` | `86400` | 1 day. |
| `ETL_GROUP_TTL_SEC` | `3600` | |
| `ETL_STALE_JOB_MAX_AGE_MS` | `604800000` | Jobs older than this are dropped. |
| `ETL_SUBMIT_MAX_ATTEMPTS` | `5` | Bounds requeue-with-payload. |
| `ETL_ERROR_BACKOFF_MS` | `30000` | |
| `ETL_SUBMIT_QUEUE` | `etranslation_submit` | |
| `BULL_QUEUE_NAMES_CSV` | — | Must include `etranslation_submit`. |
| `ENABLED_JOBS` | — | Must include `submit_group` and `translation_failed`. |
| `PORTAL_URL`, `REDIS_HOST`, `REDIS_PORT`, `TRANSLATION_AUTH_TOKEN` | — | `TRANSLATION_AUTH_TOKEN` is a shared secret; never put it in a commit or an issue. |

Plone-side: `ETRANSLATION_DISABLE_DAYTIME_DELAY` (bypasses the 19:00–07:00
window). It must be set on the **web** pods — that is where the delay is
computed — and it is read once at import, so pods must restart after changing it.

---

## 12. Deploy order is load-bearing

**Deploy this worker before the Plone change.**

Plone is what starts sending failure notifications. If `translation_failed` is
not in the worker's `ENABLED_JOBS`, every notification is rejected with
`RateLimitError` and retried immediately — a busy loop against Redis.

The reverse order is harmless: a new worker with an old Plone simply never sees
grouped callbacks, and grouping's startup guards disable it if the queue or job
is missing.

The Plone-side preconditions for `ETL_GROUPING_ENABLED=true`:

1. `@@call-etranslation` accepts a comma-separated `target_lang` and an optional
   `ext_ref`.
2. `@@translate-callback` forwards `targetLanguage` as `language` in the queued
   `save_translated_html` payload.
3. `@@translate-failure` exists and queues `translation_failed`.

---

## 13. Known warts

- **Grouping fragments under capacity pressure.** `readAndCloseGroup` closes the
  group and clears the armed key before the submit is attempted. If the gate is
  full, `requeueSubmit` re-queues the **frozen** payload — it does not re-open the
  group. Any language that arrives after the close therefore arms a *new* window
  and produces a second submission for the same object. Capacity pressure
  multiplies submissions, which fills the gate further: a feedback loop.

  Measured on a real run: 52 groups for 7 objects, group sizes
  `1×22, 2×7, 3×6, 8×1, 18×1, 26×13` — only 13 of 50 submissions were full
  26-language bundles, averaging 8.4 languages each. That is an ~8× reduction
  where 26× was intended. `requeued_at_capacity` was 229 at
  `ETL_MAX_INFLIGHT=10`.

  Fixes, in order of preference: raise `ETL_MAX_INFLIGHT` (cheapest, removes the
  trigger); on a capacity requeue, put the payload's languages back into the
  group set so stragglers merge instead of forking; or widen
  `ETL_GROUP_WINDOW_MS`. Check the group-size distribution before tuning anything
  else — it is the single number that says whether bundling is actually working:

  ```sh
  for k in $(redis-cli --scan --pattern 'cca:corr:*'); do
    redis-cli HGET "$k" langs
  done | awk -F, '{print NF}' | sort -n | uniq -c
  ```

- **Stale leases linger in `cca:inflight:idx`.** Harmless — `inFlightCount()`
  prunes by score before counting — but it means `ZCARD cca:inflight:idx` on its
  own over-reports. Read `/stats` instead of counting the zset by hand.

- **Quota detection string-matches `-11200`.** Plone flattens the upstream
  failure into a `ValueError` whose message contains `errorCode=-11200`, so the
  worker parses text rather than a structured field. Fixing it properly means
  changing `@@call-etranslation`'s error shape.
- **`_parse_rest_v2_callback` raises on `errorCode`**, so a per-language delivery
  failure queues no save job and the slot sits until the lease expires. Mitigated
  by failure notifications, not eliminated.
- **Plone's localhost / empty-HTML short-circuit returns `transId: "not-called"`.**
  That is a string, and `"not-called" < 0` is false in JS, so it once passed as a
  success — which for a bundled submission would park a phantom in the gate for a
  full lease. Guarded by `wasSubmitted()`.
- **`removeOnComplete` is capped at 1000.** Completed jobs retain their full HTML
  payload; a full sweep is ~137k jobs, and an uncapped retention grew Redis
  without bound.
- **`version.txt` points at the wrong image namespace.** Cosmetic, but it has
  misled release automation once.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Submission** | One eTranslation request, possibly carrying many languages. The unit the quota counts. |
| **Delivery** | One callback, one language. A 26-language submission produces up to 26 deliveries. |
| **Token** | The 16-hex correlation id; `externalReference` is `cca-<token>`. |
| **Group** | The per-object set of languages collected during one window. |
| **Lease** | A slot in the in-flight gate, reclaimed on timeout if not released. |
| **Sweep** | A full re-translation of all published content into all target languages. |
