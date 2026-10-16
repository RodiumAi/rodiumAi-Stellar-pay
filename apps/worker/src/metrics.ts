/** Minimal Prometheus text exposition until OpenTelemetry arrives in Sprint 10 (§18). */
export interface Metrics {
  set(name: string, value: number): void;
  inc(name: string, by?: number): void;
  get(name: string): number;
  render(): string;
}

export function createMetrics(): Metrics {
  const values = new Map<string, number>();
  return {
    set(name, value) {
      values.set(name, value);
    },
    inc(name, by = 1) {
      values.set(name, (values.get(name) ?? 0) + by);
    },
    get(name) {
      return values.get(name) ?? 0;
    },
    render() {
      return [...values.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${String(v)}`)
        .join('\n')
        .concat('\n');
    },
  };
}
