# Running unbuilt code in production (async worker)

A procedure for testing changes to this worker against **real production traffic
and real Redis state** without building and releasing an image.

It works because the production image is a full dev environment. It is a hack,
it is out of band, and it must never become how this service is released.

Use it when: a change is cheap to describe but expensive to prove in staging —
queue semantics, gate behaviour, correlation handling, anything that only
happens with real eTranslation round-trips.

Do not use it when: the change is risky, large, or you might forget it is on.

---

## Why this is possible at all

The Dockerfile does not strip anything:

```dockerfile
RUN npm install     # NODE_ENV unset → devDependencies ARE installed
COPY . .            # src/, test/, tsconfig.json ship in the image
RUN npx tsc
CMD ["node", "dist/index.js"]
```

Verified inside the running production container:

```
/usr/src/app → dist  src  test  tsconfig.json  node_modules
node_modules/.bin → nodemon  ts-node  ts-node --transpile-only  vitest
npx tsc --noEmit → exit 0
```

So the image can already compile and run TypeScript. The only thing missing is
the *new* source — and there is no `git` binary in the image, so it has to be
pushed in rather than cloned.

`src/` is ~56 KB / ~1,450 lines of flat files, which fits comfortably in a
ConfigMap (1 MB limit).

---

## The procedure

### 0. Save a revert anchor

Always, before anything else:

```sh
kubectl -n <ns> get deploy async -o json > /tmp/async-original.json
```

This is the only reliable way back.

### 1. One-time patch: mount source, run the TS

```sh
kubectl -n <ns> create configmap async-src --from-file=src/ \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n <ns> patch deploy/async --type=merge -p '{
  "spec":{"template":{"spec":{
    "containers":[{
      "name":"async",
      "command":["npx","ts-node","--transpile-only","src/index.ts"],
      "volumeMounts":[{"name":"src","mountPath":"/usr/src/app/src"}]
    }],
    "volumes":[{"name":"src","configMap":{"name":"async-src"}}]
  }}}}'
```

Notes:

- `--from-file=src/` flattens the directory. That is fine while `src/` has no
  subdirectories; if it grows any, switch to a PVC or generate keys with paths.
- Do **not** use `subPath` for the mount — `subPath` mounts never receive
  ConfigMap updates.
- The mount is read-only by default. Leave it that way.

### 2. The deploy loop (~20 seconds)

```sh
git checkout develop && git pull
kubectl -n <ns> create configmap async-src --from-file=src/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n <ns> rollout restart deploy/async
```

Annotate the ConfigMap with the commit so you always know what is running:

```sh
kubectl -n <ns> annotate configmap async-src \
  "cca.dev/commit=$(git rev-parse HEAD)" --overwrite
```

### 3. Confirm which code is actually live

Do not assume. The startup banner is the cheapest proof, and it also tells you
the effective gate configuration:

```sh
kubectl -n <ns> logs deploy/async --tail=20 | grep -E "Grouping:|Enabled jobs"
```

For a specific change, add a temporary log line or bump a version string — and
remove it before merging.

### 4. Revert

```sh
kubectl replace --force -f /tmp/async-original.json
kubectl -n <ns> delete configmap async-src
```

---

## Impact: what is ephemeral, and what is not

Five different lifetimes are in play. Confusing them is how people get surprised.

| Thing | Lifetime | Consequence |
|---|---|---|
| The **image** | unchanged | This is your rollback. Nothing is baked into it. |
| The **ConfigMap object** | persists until deleted | A cluster object, not a pod object. Survives pod restarts. |
| The **mounted files** in a pod | recreated from the ConfigMap on every pod start | Gone when the pod dies. Nothing persists in the container filesystem. |
| The **Deployment patch** (`command` + volume) | survives pod restarts, evictions, node drains | **Overwritten by the next `helm upgrade` or `helm rollback`.** |
| The **running process's** loaded code | until restart | ConfigMap edits reach the files within ~1 min, but Node has already loaded the modules — you still need a restart. |

So: the code is ephemeral, the patch is semi-persistent, and the image is
untouched.

### Operational impact while it is on

- **Startup is slower, but not dangerously so.** Measured in the production
  container: `ts-node --transpile-only` cold start ≈ **590 ms** vs 35 ms for
  plain node; a few seconds once it imports bullmq/fastify/ioredis. The
  `startupProbe` allows up to ~70 s (`initialDelay 10` + 12 × 5 s) before
  killing the pod, and the `livenessProbe` is a bare `tcpSocket`. Comfortable
  margin.
- **`--transpile-only` skips type-checking.** A type error becomes a runtime
  error in production. Check it in the pod after restarting:
  `kubectl -n <ns> exec deploy/async -- npx tsc --noEmit`
- **Runtime cost is negligible.** ts-node compiles once at load; it is not
  slower per job.
- **Source becomes readable** to anyone with pod read access (mode 0644). Not a
  secret, but do not put anything secret in a ConfigMap.
- **1 MB ConfigMap ceiling.** 56 KB today. Watch it if `src/` grows or you add
  fixtures.

### The footgun that will actually get you

The image's `dist/` is still present, and `CMD ["node","dist/index.js"]` is
still the default. The moment the patch is removed — by a `helm upgrade`, a
`helm rollback`, or someone re-applying the chart — the pod **silently reverts
to the old compiled code**, with no error and no log.

Which means: *"we tested the fix in production"* does not imply *"production is
running the fix"*. Always re-check the banner after any Helm operation.

The same class of drift applies to manual env overrides, e.g.
`kubectl set env deploy/plone ETRANSLATION_DISABLE_DAYTIME_DELAY=1`. Those are
also reverted by the next `helm upgrade`. Treat any manual patch as a
ticking clock.

---

## Guardrails for testing against live traffic

The worker is a single replica and stateless apart from Redis, which makes a
clean window easy:

```sh
kubectl -n <ns> scale deploy/async --replicas=0   # jobs queue in Redis, nothing lost
# run the dev worker, trigger one page, watch
kubectl -n <ns> scale deploy/async --replicas=1
```

**Do not run two workers on the same queues.** BullMQ distributes jobs between
them, so you cannot control which worker handles what, and a bug in new code
would silently process a share of real traffic.

Shared state you can damage:

| Shared resource | Risk |
|---|---|
| `cca:inflight:idx` | a buggy worker leaves phantom leases and starves the gate for everyone |
| `cca:corr:*`, `cca:done:*` | wrong correlation or poisoned skip cache |
| **eTranslation's 50-submission quota** | a runaway dev worker burns the budget and the production worker starts seeing `-11200` |

Mitigations: `ETL_MAX_INFLIGHT=1` on the dev worker, test with a single page,
and confirm the gate is empty afterwards (`GET /stats` → `inFlight: 0`).

Remember the Plone-side daytime delay: jobs queued between 07:00 and 19:00 are
stamped with a delay to 19:00 unless `ETRANSLATION_DISABLE_DAYTIME_DELAY` is set
on the **web** pods.

---

## Should this go into the Helm chart?

**No — deliberately.**

The chart is the source of truth for what serves production traffic. A value
that means *"run interpreted source instead of the released image"* would make
the drift permanent and invisible, and would put a loaded footgun in front of
every future operator.

The fact that `helm upgrade` wipes the patch is a **feature**: it guarantees the
hack cannot survive into a real release.

Keep this procedure out of band — in this repo's `docs/`, with the revert anchor
— and let Helm be the thing that cleans up after you.

If this becomes routine, the right chart change is not a patch toggle but a
**separate staging worker**: its own deployment, its own image tag built from
`develop`, its own `ETL_MAX_INFLIGHT`, pointed at a staging portal. That gives
you the same real-traffic testing with provenance, rollback and no drift.

---

## What this never replaces

A release still needs an image, because the ConfigMap path has:

- **no version pin** — nothing ties the running code to a commit except an
  annotation you have to remember to set;
- **no rollback** beyond a JSON file in `/tmp`;
- **no provenance** — `kubectl describe` will not tell you what shipped.

Use it to *learn*, then ship the image.
