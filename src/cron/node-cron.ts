import cron from "node-cron";
import type { CronScheduler } from "./index.js";

export interface NodeCronTask {
  stop(): void;
}

export interface NodeCronImpl {
  schedule(
    expression: string,
    fn: () => void,
    options?: { timezone?: string },
  ): NodeCronTask;
  validate(expression: string): boolean;
}

export interface NodeCronOpts {
  impl?: NodeCronImpl;
}

export function nodeCronScheduler(opts: NodeCronOpts = {}): CronScheduler {
  const impl: NodeCronImpl =
    opts.impl ?? {
      schedule: (expr, fn, o) => cron.schedule(expr, fn, o),
      validate: (expr) => cron.validate(expr),
    };

  return {
    name: "node-cron",

    async doctor() {
      try {
        const ok = impl.validate("* * * * *");
        return {
          ok: ok === true,
          details: { validated: "* * * * *", ok },
        };
      } catch (err) {
        return {
          ok: false,
          details: {
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },

    async schedule({ triggerId, expression, timezone, handler }) {
      if (!impl.validate(expression)) {
        throw new Error(`Invalid cron expression: ${expression}`);
      }
      const task = impl.schedule(
        expression,
        () => {
          handler().catch((err) => {
            console.error(
              `[cron] trigger ${triggerId} handler error:`,
              err,
            );
          });
        },
        timezone ? { timezone } : undefined,
      );
      return {
        async cancel() {
          task.stop();
        },
      };
    },

    async close() {
      // node-cron has no global close
    },
  };
}
