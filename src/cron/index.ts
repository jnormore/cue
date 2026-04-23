import { nodeCronScheduler } from "./node-cron.js";

export interface CronHandle {
  cancel(): Promise<void>;
}

export interface CronScheduleArgs {
  triggerId: string;
  expression: string;
  timezone?: string;
  handler: () => Promise<void>;
}

export interface CronScheduler {
  name: string;
  doctor(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  schedule(args: CronScheduleArgs): Promise<CronHandle>;
  close(): Promise<void>;
}

export function pickCron(name: string): CronScheduler {
  switch (name) {
    case "node-cron":
      return nodeCronScheduler();
    default:
      throw new Error(
        `Unknown cron scheduler: "${name}". Known schedulers: node-cron`,
      );
  }
}
