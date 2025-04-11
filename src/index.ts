import { JOBS_MAPPING } from "./jobs";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue, Worker, RateLimitError } from "bullmq";
import { fastifyQueueDashPlugin } from "@queuedash/api";

import fastify from "fastify";
import IORedis from "ioredis";

const port = parseInt(process.env.PORT || "3000");
const enabledJobs = (
  process.env.ENABLED_JOBS || "call_etranslation,save_translated_html"
).split(",");

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
        delay: 1000,
        type: "exponential",
      },
    },
  });

function setupBullMQProcessor(queueName: string) {
  const worker = new Worker(
    queueName,
    async (job) => {
      if (enabledJobs.indexOf(job.name) === -1) {
        throw Worker.RateLimitError();
      }

      const handler = JOBS_MAPPING[job.name];

      if (handler) {
        try {
          const result = await handler(job.data);
          return { jobId: job.id, result };
        } catch (error) {
          if (error instanceof RateLimitError) {
            console.log("Backing off due to rate limit");
            await job.log("Backing off due to rate limit");
            worker.rateLimit(5000);
            throw Worker.RateLimitError();
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
          const res = 5000 + Math.random() * 500;
          console.log("backoff", res, attemptsMade, type_, err, job);
          return res;
        },
      },
    },
  );
}

function readQueuesFromEnv() {
  const qStr =
    process.env.BULL_QUEUE_NAMES_CSV || "etranslation,save_etranslation";
  try {
    const qs = qStr.split(",");
    return qs.map((q) => q.trim());
  } catch (e) {
    console.error(e);
    return [];
  }
}

const run = async () => {
  const queues = readQueuesFromEnv().map((q) => createQueueMQ(q));

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

  app.get("/add", (req, reply) => {
    const opts = (req.query as any).opts || {};

    if (opts.delay) {
      opts.delay = +opts.delay * 1000; // delay must be a number
    }

    queues.forEach((queue) =>
      queue.add("Add", { title: (req.query as any).title }, opts),
    );

    reply.send({
      ok: true,
    });
  });

  app.get("/status", (req, reply) => {
    console.log(connection.status);
    reply.send({ status: connection.status });
  });

  await app.listen({ host: "0.0.0.0", port });

  console.log(`For the UI, open http://localhost:${port}/ui`);
  console.log(
    "Make sure Redis is configured in env variables. See .env.example",
  );
  console.log("To populate the queue, run:");
  console.log(`  curl http://localhost:${port}/add?title=Example`);
  console.log("To populate the queue with custom options (opts), run:");
  console.log(`  curl http://localhost:${port}/add?title=Test&opts[delay]=9`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
