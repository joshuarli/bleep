export const RING_CAPACITY = 36_000;

export class Ring<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;
  private discardedCount = 0;

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`ring capacity ${capacity}`);
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get discarded(): number {
    return this.discardedCount;
  }

  push(item: T): void {
    if (this.count === this.capacity) {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
      this.discardedCount++;
      return;
    }
    this.items[(this.start + this.count) % this.capacity] = item;
    this.count++;
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.items[(this.start + index) % this.capacity];
  }

  oldest(): T | undefined {
    return this.at(0);
  }

  newest(): T | undefined {
    return this.at(this.count - 1);
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.count; i++) yield this.items[(this.start + i) % this.capacity] as T;
  }

  toArray(): T[] {
    return [...this];
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
    this.discardedCount = 0;
  }
}
