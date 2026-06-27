// 指数退避（03-spec §10）：默认 0.5s 起、×2、封顶 8s。供断线重连编排。

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface Backoff {
  /** 取本次等待 ms 并推进到下一档。 */
  next(): number;
  /** 连接成功后复位到初始档。 */
  reset(): void;
}

export function makeBackoff(opts: BackoffOptions = {}): Backoff {
  const initial = opts.initialMs ?? 500;
  const max = opts.maxMs ?? 8000;
  const factor = opts.factor ?? 2;
  let current = initial;
  return {
    next(): number {
      const v = current;
      current = Math.min(max, current * factor);
      return v;
    },
    reset(): void {
      current = initial;
    },
  };
}
