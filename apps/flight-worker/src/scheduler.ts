import { idleTickDelayMs } from "./env.js";

export class InterruptibleWorkerScheduler {
  readonly #run: () => Promise<boolean>;
  readonly #onError: (error: unknown) => void;
  readonly #tickMs: number;
  readonly #maxIdleTickMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #wakePending = false;
  #stopped = true;
  #consecutiveIdleTicks = 0;

  constructor(options: {
    run: () => Promise<boolean>;
    onError: (error: unknown) => void;
    tickMs: number;
    maxIdleTickMs: number;
  }) {
    this.#run = options.run;
    this.#onError = options.onError;
    this.#tickMs = options.tickMs;
    this.#maxIdleTickMs = options.maxIdleTickMs;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Interrupt an idle backoff, or run once more after an in-flight tick. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#wakePending = true;
      return;
    }
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    this.#wakePending = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#tick(), delayMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    this.#timer = undefined;
    if (this.#stopped) return;
    if (this.#running) {
      this.#wakePending = true;
      return;
    }
    this.#running = true;
    let nextTickMs = this.#tickMs;
    try {
      const hadDueWork = await this.#run();
      this.#consecutiveIdleTicks = hadDueWork ? 0 : this.#consecutiveIdleTicks + 1;
      nextTickMs = idleTickDelayMs(
        this.#tickMs,
        this.#maxIdleTickMs,
        this.#consecutiveIdleTicks
      );
    } catch (error) {
      this.#consecutiveIdleTicks = 0;
      this.#onError(error);
    } finally {
      this.#running = false;
      if (this.#stopped) return;
      if (this.#wakePending) {
        this.#wakePending = false;
        this.#schedule(0);
      } else {
        this.#schedule(nextTickMs);
      }
    }
  }
}
