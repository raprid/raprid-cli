// 画面から独立したデータ取得の状態。React からは useSyncExternalStore で読む。
//
// SnapshotStore: 2 秒ごとに ui snapshot を取得する。同時実行は 1 件で、実行中の再取得要求は次回へまとめる。
//   タイムアウトしたら自動取得を止め、r (refresh) で再開する。失敗しても前回の表示を保つ。
// DetailStore: 選択の変化を 100ms まとめてから show を取得する。同時実行は 1 件で、
//   選択が変わった古い応答は表示しない。path + revision でキャッシュする。

import { type Backend, BackendError } from "./backend.js";
import type { Kind, ShowResult, Snapshot } from "./types.js";

type Listener = () => void;

class Emitter<T> {
  protected state: T;
  private listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  getState = (): T => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected set(next: T): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export interface FetchError {
  code: string;
  message: string;
  at: Date;
}

export interface SnapshotState {
  snapshot: Snapshot | undefined;
  loading: boolean;
  error: FetchError | undefined;
  fetchedAt: Date | undefined;
  stopped: boolean; // タイムアウトで自動取得を止めた
}

function toFetchError(error: unknown, now: Date): FetchError {
  if (error instanceof BackendError) return { code: error.code, message: error.message, at: now };
  return { code: "FAILED", message: error instanceof Error ? error.message : String(error), at: now };
}

export class SnapshotStore extends Emitter<SnapshotState> {
  private readonly backend: Backend;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private generation = 0;
  private inFlight = false;
  private pending = false;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(backend: Backend, options: { intervalMs?: number; now?: () => Date } = {}) {
    super({ snapshot: undefined, loading: false, error: undefined, fetchedAt: undefined, stopped: false });
    this.backend = backend;
    this.intervalMs = options.intervalMs ?? 2000;
    this.now = options.now ?? (() => new Date());
  }

  // 画面を開く前に取得した結果を使い、次の取得を予約する
  seed(snapshot: Snapshot): void {
    this.set({ snapshot, loading: false, error: undefined, fetchedAt: this.now(), stopped: false });
  }

  start(): void {
    if (this.state.snapshot && !this.inFlight) {
      this.timer = setTimeout(() => this.refresh(), this.intervalMs);
      return;
    }
    this.refresh();
  }

  // 手動の再取得。タイムアウトで止めた自動取得も再開する
  refresh(): void {
    if (this.disposed) return;
    if (this.state.stopped) this.set({ ...this.state, stopped: false });
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    clearTimeout(this.timer);
    void this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    const generation = ++this.generation;
    this.set({ ...this.state, loading: true });
    try {
      const snapshot = await this.backend.snapshot();
      if (this.disposed || generation !== this.generation) return;
      this.set({ snapshot, loading: false, error: undefined, fetchedAt: this.now(), stopped: false });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      const failure = toFetchError(error, this.now());
      this.set({ ...this.state, loading: false, error: failure, stopped: failure.code === "TIMEOUT" });
    } finally {
      this.inFlight = false;
      if (!this.disposed) {
        if (this.pending) {
          this.pending = false;
          void this.run();
        } else if (!this.state.stopped) {
          this.timer = setTimeout(() => this.refresh(), this.intervalMs);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
  }
}

export interface DetailTarget {
  kind: Kind;
  job: string;
  name: string;
  path: string;
  revision: string | null;
}

export interface DetailState {
  target: DetailTarget | undefined;
  result: ShowResult | undefined; // target の path の最新の取得結果 (revision が古い場合もある)
  current: boolean; // result が target の revision と一致する
  loading: boolean;
  error: FetchError | undefined;
}

const cacheLimit = 64;

export class DetailStore extends Emitter<DetailState> {
  private readonly backend: Backend;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly byRevision = new Map<string, ShowResult>();
  private readonly byPath = new Map<string, ShowResult>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: DetailTarget | undefined;
  private disposed = false;

  constructor(backend: Backend, options: { debounceMs?: number; now?: () => Date } = {}) {
    super({ target: undefined, result: undefined, current: false, loading: false, error: undefined });
    this.backend = backend;
    this.debounceMs = options.debounceMs ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  private static key(target: DetailTarget): string {
    return `${target.path}\u0000${target.revision ?? ""}`;
  }

  private static same(a: DetailTarget | undefined, b: DetailTarget | undefined): boolean {
    return a === b || (a !== undefined && b !== undefined && DetailStore.key(a) === DetailStore.key(b));
  }

  private remember(target: DetailTarget, result: ShowResult): void {
    const key = DetailStore.key(target);
    this.byRevision.delete(key);
    this.byRevision.set(key, result);
    this.byPath.set(target.path, result);
    while (this.byRevision.size > cacheLimit) this.byRevision.delete(this.byRevision.keys().next().value!);
    while (this.byPath.size > cacheLimit) this.byPath.delete(this.byPath.keys().next().value!);
  }

  // 選択の変更。同じ path・revision なら何もしない
  select(target: DetailTarget | undefined): void {
    if (this.disposed || DetailStore.same(target, this.state.target)) return;
    clearTimeout(this.timer);
    if (!target) {
      this.set({ target: undefined, result: undefined, current: false, loading: false, error: undefined });
      return;
    }
    const cached = this.byRevision.get(DetailStore.key(target));
    if (cached) {
      this.set({ target, result: cached, current: true, loading: false, error: undefined });
      return;
    }
    // 取得するまでは同じ path の前回の結果を出す (別の項目の本文は出さない)
    this.set({ target, result: this.byPath.get(target.path), current: false, loading: true, error: undefined });
    this.timer = setTimeout(() => this.load(), this.debounceMs);
  }

  // 取得失敗の後などに、今の対象を取り直す
  reload(): void {
    const target = this.state.target;
    if (!target || this.disposed) return;
    this.byRevision.delete(DetailStore.key(target));
    this.set({ ...this.state, loading: true, error: undefined });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 0);
  }

  private async load(): Promise<void> {
    const target = this.state.target;
    if (!target || this.inFlight) return; // 実行中の取得が終わったら最新の対象を取り直す
    this.inFlight = target;
    try {
      const result = await this.backend.show(target.kind, target.job, target.name);
      if (this.disposed) return;
      this.remember({ ...target, revision: result.item.revision }, result);
      if (DetailStore.same(target, this.state.target)) {
        this.set({ target, result, current: result.item.revision === target.revision, loading: false, error: undefined });
      }
    } catch (error) {
      if (this.disposed) return;
      if (DetailStore.same(target, this.state.target)) this.set({ ...this.state, loading: false, error: toFetchError(error, this.now()) });
    } finally {
      this.inFlight = undefined;
      const latest = this.state.target;
      if (!this.disposed && latest && !DetailStore.same(latest, target) && this.state.loading) this.timer = setTimeout(() => this.load(), 0);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
