import { withSpan } from '@rp/telemetry/tracing';
import type { Logger } from 'pino';

export interface Job {
  readonly name: string;
  readonly intervalMs: number;
  /** One idempotent pass; must stop starting new work once `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
}

export type JobLogger = Pick<Logger, 'error' | 'info' | 'warn'>;

export interface Scheduler {
  /** Stop claiming, let in-flight passes finish within `graceMs` (context §15). */
  stop(graceMs: number): Promise<{ readonly drained: boolean }>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** In-process scheduler: each job loops run → wait interval, independently of the others. */
export function startScheduler(jobs: readonly Job[], logger: JobLogger): Scheduler {
  const controller = new AbortController();
  const loops = jobs.map(async (job) => {
    while (!controller.signal.aborted) {
      try {
        await withSpan(`job ${job.name}`, { 'rp.job': job.name }, () => job.run(controller.signal));
      } catch (error) {
        logger.error({ err: error, job: job.name }, 'job pass failed');
      }
      await sleep(job.intervalMs, controller.signal);
    }
  });
  return {
    async stop(graceMs) {
      controller.abort();
      const all = Promise.all(loops).then(() => true);
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, graceMs).unref();
      });
      return { drained: await Promise.race([all, timeout]) };
    },
  };
}
