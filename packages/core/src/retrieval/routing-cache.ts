/** Per-service LRU of candidate computations only. No credentials, task text or verified artifacts. */
export class RoutingCache<T> {
  readonly #entries = new Map<string, { json: string; expires: number; bytes: number }>();
  #bytes = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttl: number,
  ) {}
  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }
  get size() {
    return this.#entries.size;
  }
  get bytes() {
    return this.#bytes;
  }
  private remove(key: string) {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#bytes -= entry.bytes;
      this.#entries.delete(key);
    }
  }
  get(key: string, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.expires) {
      this.remove(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return JSON.parse(entry.json) as T;
  }
  set(key: string, value: T, now = Date.now()) {
    this.remove(key);
    if (!this.maxEntries || !this.maxBytes) return;
    for (const [k, v] of this.#entries) if (now >= v.expires) this.remove(k);
    const json = JSON.stringify(value),
      bytes = 2 * (json.length + key.length) + 256;
    if (bytes > this.maxBytes) return;
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
      const first = this.#entries.keys().next().value;
      if (first === undefined) break;
      this.remove(first);
    }
    this.#entries.set(key, { json, expires: now + this.ttl, bytes });
    this.#bytes += bytes;
  }
}
