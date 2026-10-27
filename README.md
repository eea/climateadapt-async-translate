# climateadapt-async-translate

Node.js worker that drives the asynchronous translation workflow for
[Climate-ADAPT](https://climate-adapt.eea.europa.eu). It sits between the Plone
backend and the EC's eTranslation service, using BullMQ + Redis for queuing and
for the state that keeps submissions inside eTranslation's concurrency quota.

Image: [`eeacms/climateadapt-async-translate`](https://hub.docker.com/r/eeacms/climateadapt-async-translate)

## Documentation

| Document | What it is |
|---|---|
| **[docs/TRANSLATION-MECHANISM.md](docs/TRANSLATION-MECHANISM.md)** | The authoritative reference: the full pipeline, the quota mechanisms, Redis key inventory, configuration, throughput limits, known gaps, and **how to probe a live deployment**. Read this first if you are debugging or operating the pipeline. |
| [PROJECT.md](PROJECT.md) | Service overview: role, tech stack, job types, queues, development workflow. |
| [docs/RUNNING-UNBUILT-CODE.md](docs/RUNNING-UNBUILT-CODE.md) | How to test changes against real production traffic **without building an image** — what that costs, what is ephemeral, and why it stays out of the Helm chart. |

## Why the design is unusual

eTranslation enforces a **concurrency** quota of 50 active submissions per
client, not a rate limit. Submitting one request per (object, language) across 26
languages exhausts it in seconds. So this worker:

- **bundles** the 26 per-language jobs for an object into a single request
  (26× fewer submissions),
- **gates** concurrent submissions with a Redis-backed lease system so the quota
  is never exceeded, and requeues rather than failing when it is,
- **skips** languages already translated for byte-identical source HTML.

The mechanisms, their tuning knobs and their failure modes are documented in
[docs/TRANSLATION-MECHANISM.md](docs/TRANSLATION-MECHANISM.md).

## Quick start

```sh
cp env.example .env    # fill in REDIS_HOST, PORTAL_URL, TRANSLATION_AUTH_TOKEN
npm install
npm start              # nodemon + ts-node
```

```sh
npm run build          # tsc
npm test               # vitest; uses an in-memory Redis double, no network needed
npm run lint
```

See `env.example` for every knob and its default.

## Deploying

Deployed via the `cca-backend` Helm chart. Two things are load-bearing:

- **Deploy this worker before the matching Plone change.** If
  `translation_failed` is missing from `ENABLED_JOBS` while Plone is sending
  failure notifications, every notification is rejected and retried immediately -
  a busy loop.
- **`ETL_GROUPING_ENABLED` must stay `false` until the Plone side that accepts a
  multi-language `target_lang` and forwards `targetLanguage` is live.** Grouping
  disables itself at startup if `etranslation_submit` or `submit_group` is
  missing, but do not rely on that as the safety mechanism.
