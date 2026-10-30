/**
 * Prober — the two-level probe scheduler (docs/ip-pool.md section 4.1).
 *
 * Hard constraints (do not "optimize" them away):
 *  1. Serial per exit: at most one in-flight probe per exit (per-exit probe
 *     lock in ExitPool) — one exit IP is one shared quota bucket; concurrent
 *     probes against it are self-inflicted 429s.
 *  2. Bounded concurrency across exits: `maxConcurrentProbes` workers (default
 *     3) protect the upstream total request rate, the probed public proxies
 *     and local bandwidth.
 *  3. Same-exit models run back-to-back (no lock re-acquisition churn);
 *     different exits interleave.
 *
 * The scheduler is generic over the actual probe task: admission probes and
 * the settings card's 探测/批量探活 actions all enqueue through the same
 * queue. Tasks are async functions returning a verdict already applied to the
 * pool by the caller.
 */

import type { ExitPool } from './pool.ts'

export interface ProbeTask {
  /** Exit the task probes (drives serialization + the lock). */
  exitId: string
  /** Optional label for diagnostics. */
  kind: string
  run: () => Promise<void>
}

export interface ProberOptions {
  pool: ExitPool
  /** Global in-flight cap across exits (docs/ip-pool.md 4.6). */
  maxConcurrentProbes?: number
}

interface QueueSlot {
  task: ProbeTask
  resolve: () => void
}

export class Prober {
  readonly #pool: ExitPool
  #maxConcurrent: number
  #queue: QueueSlot[] = []
  #inFlight = 0
  /** Candidates outside the pool with a task running (no pool lock to hold). */
  readonly #busy = new Set<string>()
  #drained: (() => void) | null = null
  /** Queue snapshot counter for the settings-page progress (x/y). */
  #enqueued = 0
  #completed = 0

  constructor(options: ProberOptions) {
    this.#pool = options.pool
    this.#maxConcurrent = Math.max(1, options.maxConcurrentProbes ?? 3)
  }

  get stats(): { queued: number; inFlight: number; enqueued: number; completed: number } {
    return {
      queued: this.#queue.length,
      inFlight: this.#inFlight,
      enqueued: this.#enqueued,
      completed: this.#completed,
    }
  }

  setMaxConcurrent(value: number): void {
    this.#maxConcurrent = Math.max(1, value)
    this.#pump()
  }

  /** Enqueue one task; resolves when the task has fully run. */
  enqueue(task: ProbeTask): Promise<void> {
    this.#enqueued += 1
    return new Promise<void>((resolve) => {
      this.#queue.push({ task, resolve })
      this.#pump()
    })
  }

  /** Enqueue a batch; same-exit tasks are kept adjacent for back-to-back
   *  execution (constraint 3). Resolves when every task has run. */
  enqueueAll(tasks: ProbeTask[]): Promise<void> {
    return Promise.all(tasks.map((task) => this.enqueue(task))).then(() => undefined)
  }

  /** True when no task is queued or running. */
  get idle(): boolean {
    return this.#queue.length === 0 && this.#inFlight === 0
  }

  /** Resolves once the queue fully drains (test/UI hook). */
  async drained(): Promise<void> {
    while (!this.idle) {
      await new Promise<void>((resolve) => {
        this.#drained = resolve
      })
    }
  }

  /** A worker slot finished; release and pump. */
  #finishSlot(): void {
    this.#inFlight -= 1
    this.#completed += 1
    this.#pump()
  }

  #pump(): void {
    while (this.#inFlight < this.#maxConcurrent) {
      // Skip exits with a task in flight: their tasks stay queued in order;
      // other exits' tasks proceed.
      let locked = false
      const index = this.#queue.findIndex((slot) => {
        const claim = this.#claim(slot.task.exitId)
        if (claim === null) return false
        locked = claim
        return true
      })
      if (index < 0) break
      const [slot] = this.#queue.splice(index, 1)
      if (!slot) break
      this.#inFlight += 1
      void this.#runSlot(slot, locked)
    }
    if (this.idle) {
      const waiter = this.#drained
      this.#drained = null
      waiter?.()
    }
  }

  /**
   * Claim the exit for one task: the pool's per-exit lock for a row in the
   * table (true), the scheduler's own busy set for a candidate outside it
   * (false), or null when a task of that exit is already running.
   */
  #claim(exitId: string): boolean | null {
    if (this.#busy.has(exitId)) return null
    if (this.#pool.get(exitId) !== undefined) return this.#pool.takeProbeLock(exitId) ? true : null
    this.#busy.add(exitId)
    return false
  }

  async #runSlot(slot: QueueSlot, locked: boolean): Promise<void> {
    try {
      await slot.task.run()
    } catch {
      // Task failures are the caller's diagnostics (they own the pool marks);
      // the scheduler itself must never break.
    } finally {
      // Release only what this slot took: a candidate the task admitted into
      // the pool mid-run never held the pool lock.
      if (locked) this.#pool.releaseProbeLock(slot.task.exitId)
      else this.#busy.delete(slot.task.exitId)
      slot.resolve()
      this.#finishSlot()
    }
  }
}
