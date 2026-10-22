import { JOBS_MAPPING } from "./jobs";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue, Worker, RateLimitError } from "bullmq";
import { fastifyQueueDashPlugin } from "@queuedash/api";

import fastify from "fastify";
import IORedis from "ioredis";
import { config, DEFAULT_ENABLED_JOBS, DEFAULT_QUEUES } from "./config";
import { initDeps } from "./deps";

const port = parseInt(process.env.PORT || "3000");
const enabledJobs = (process.env.ENABLED_JOBS || DEFAULT_ENABLED_JOBS).split(
  ",",
);
const enabledQueues = readQueuesFromEnv();

const REDIS_HOST = process.env.REDIS_HOST || "0.0.0.0";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379");

const connection = new IORedis({
  maxRetriesPerRequest: null,
  port: REDIS_PORT,
  host: REDIS_HOST,
});

const createQueueMQ = (name: string) =>
  new Queue(name, {
    connection,
    defaultJobOptions: {
      backoff: {
        delay: 10000,
        type: "exponential",
      },
    },
  });

// Picked up job save_translated_html - 469637
// Save translation result {
//   error_type: '{"url": "https://climate-adapt.eea.europa.eu/ga/observatory"}'
// }
// Error in job {"url": "https://climate-adapt.eea.europa.eu/ga/observatory"}

function setupBullMQProcessor(queueName: string) {
  new Worker(
    queueName,
    async (job) => {
      if (enabledJobs.indexOf(job.name) === -1) {
        console.warn(
          `Job will not be scheduled, worker is configured to ignore it: ${job.name} - ${job.id}`,
        );
        throw Worker.RateLimitError();
      }

      const handler = JOBS_MAPPING[job.name];

      if (handler) {
        try {
          console.log(`Picked up job ${job.name} - ${job.id}`);

          const logData = (obj: any) =>
            JSON.stringify(obj, (key, value) => {
              if (typeof value === "string" && value.length > 500) {
                return value.substring(0, 500) + "... (truncated)";
              }
              return value;
            });

          await job.log(
            `Job started: ${job.name} with data: ${logData(job.data)}`,
          );

          const result = await handler(job.data, job);

          await job.log(`Job finished successfully: ${logData(result)}`);

          return { jobId: job.id, result };
        } catch (error) {
          if (error instanceof RateLimitError) {
            console.log("Backing off due to rate limit");
            await job.log("Backing off due to rate limit");
            // worker.rateLimit(5000);
            throw Worker.RateLimitError();
          } else {
            console.log(`Error in job`, error);
            const errorLog =
              error instanceof Error || (error && typeof error === "object")
                ? Object.getOwnPropertyNames(error).reduce((acc, key) => {
                  acc[key] = (error as any)[key];
                  return acc;
                }, {} as any)
                : error;
            await job.log(`Error in job ${JSON.stringify(errorLog)}`);
            throw error;
          }
        }
      } else {
        throw new Error(`Handler not found for job ${job.name}`);
      }
    },
    {
      connection,
      removeOnComplete: { count: 100000 },
      // A large failed set hides the real problem and costs Redis memory: a
      // single quota incident left 2229 failed jobs here.
      removeOnFail: { count: 10000 },
      concurrency: 1,
      settings: {
        backoffStrategy: function (attemptsMade, type_, err, job) {
          const res = 10000 + Math.random() * 500;
          console.log("backoff", res, attemptsMade, type_, err, job);
          return res;
        },
      },
    },
  );
}

function readQueuesFromEnv() {
  const qStr = process.env.BULL_QUEUE_NAMES_CSV || DEFAULT_QUEUES;
  try {
    const qs = qStr.split(",");
    return qs.map((q) => q.trim());
  } catch (e) {
    console.error(e);
    return [];
  }
}

const run = async () => {
  const store = initDeps({
    host: REDIS_HOST,
    port: REDIS_PORT,
    bullConnection: connection,
  });

  if (config.groupingEnabled && !enabledQueues.includes(config.submitQueue)) {
    console.error(
      `ETL_GROUPING_ENABLED is on but ${config.submitQueue} is not in ` +
      `BULL_QUEUE_NAMES_CSV - collected translations would never be submitted. ` +
      `Disabling grouping for this run.`,
    );
    config.groupingEnabled = false;
  }

  const queues = enabledQueues.map((q) => createQueueMQ(q));

  queues.forEach((q) => {
    setupBullMQProcessor(q.name);
  });

  const app = fastify();

  const serverAdapter = new FastifyAdapter();

  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  serverAdapter.setBasePath("/ui");
  app.register(serverAdapter.registerPlugin() as any, { prefix: "/ui" });

  app.register(fastifyQueueDashPlugin, {
    baseUrl: "/dash",
    ctx: {
      queues: queues.map((q) => ({
        queue: q, //
        displayName: "E-Translation",
        type: "bullmq" as const,
      })),
    },
  });

  app.get("/", (req, reply) => {
    return reply.redirect("/ui", 302);
  });

  // app.get("/add", (req, reply) => {
  //   const opts = (req.query as any).opts || {};
  //
  //   if (opts.delay) {
  //     opts.delay = +opts.delay * 1000; // delay must be a number
  //   }
  //
  //   queues.forEach((queue) =>
  //     queue.add("Add", { title: (req.query as any).title }, opts),
  //   );
  //
  //   reply.send({
  //     ok: true,
  //   });
  // });

  app.get("/status", (req, reply) => {
    console.log(connection.status);
    reply.send({ status: connection.status });
  });

  app.get("/stats", async (req, reply) => {
    try {
      const [inFlight, counters, breakerOpen] = await Promise.all([
        store.inFlightCount(),
        store.stats(),
        store.breakerOpen(),
      ]);
      reply.send({
        groupingEnabled: config.groupingEnabled,
        inFlight,
        maxInFlight: config.maxInFlight,
        leaseMs: config.leaseMs,
        breakerOpen,
        counters,
      });
    } catch (error: any) {
      reply.code(500).send({ error: String(error?.message || error) });
    }
  });

  await app.listen({ host: "0.0.0.0", port });

  console.log(`For the UI, open http://localhost:${port}/ui`);
  console.log(
    "Make sure Redis is configured in env variables. See .env.example",
  );
  console.log(`Enabled jobs: ${enabledJobs}`);
  console.log(`Enabled queues: ${enabledQueues}`);
  console.log(
    `Grouping: ${config.groupingEnabled ? "on" : "off"} ` +
    `(window ${config.groupWindowMs}ms, max in flight ${config.maxInFlight}, ` +
    `lease ${config.leaseMs}ms, skip cache ${config.skipCache ? "on" : "off"})`,
  );
  if (!config.groupingEnabled) {
    console.log(
      "Grouping is off: one eTranslation submission per (object, language). " +
      "Requires the Plone change that accepts a comma separated target_lang and " +
      "ext_ref on @@call-etranslation and forwards targetLanguage from " +
      "@@translate-callback.",
    );
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
