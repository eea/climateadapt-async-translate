import { JOBS_MAPPING } from "./jobs";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue, Worker, RateLimitError } from "bullmq";
import { fastifyQueueDashPlugin } from "@queuedash/api";

import fastify from "fastify";
import IORedis from "ioredis";

const DEFAULT_ENABLED_JOBS =
  "call_etranslation,save_translated_html,sync_translated_paths,delete_translation";
const DEFAULT_QUEUES = "etranslation,save_etranslation,sync_paths,delete_translation";

const port = parseInt(process.env.PORT || "3000");
const enabledJobs = (process.env.ENABLED_JOBS || DEFAULT_ENABLED_JOBS).split(
  ",",
);
const enabledQueues = readQueuesFromEnv();

const connection = new IORedis({
  maxRetriesPerRequest: null,
  port: parseInt(process.env.REDIS_PORT || "6379"),
  host: process.env.REDIS_HOST || "0.0.0.0",
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
  const worker = new Worker(
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
          const result = await handler(job.data);
          return { jobId: job.id, result };
        } catch (error) {
          if (error instanceof RateLimitError) {
            console.log("Backing off due to rate limit");
            await job.log("Backing off due to rate limit");
            // worker.rateLimit(5000);
            throw Worker.RateLimitError();
          } else {
            console.log(`Error in job`, error);
            await job.log(`Error in job ${JSON.stringify(error)}`);
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
      removeOnFail: { count: 500000 },
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

  await app.listen({ host: "0.0.0.0", port });

  console.log(`For the UI, open http://localhost:${port}/ui`);
  console.log(
    "Make sure Redis is configured in env variables. See .env.example",
  );
  console.log(`Enabled jobs: ${enabledJobs}`);
  console.log(`Enabled queues: ${enabledQueues}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
