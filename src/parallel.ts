export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw Error("Invalid concurrency");
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit)
      await new Promise<void>((resolve, reject) => {
        const next = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.queue = this.queue.filter((x) => x !== next);
          reject(signal?.reason);
        };
        this.queue.push(next);
        signal?.addEventListener("abort", abort, { once: true });
      });
    else this.active++;
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
export async function parallel<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
) {
  const gate = new Semaphore(limit);
  return Promise.allSettled(
    items.map((item) => gate.run(() => fn(item), signal)),
  );
}
