type Labels = Record<string, string | number>;

function keyOf(name: string, labels: Labels = {}): string {
  const entries = Object.keys(labels).sort().map((key) => `${key}="${String(labels[key]).replace(/"/g, "'")}"`);
  return entries.length ? `${name}{${entries.join(',')}}` : name;
}

class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, { count: number; sum: number; buckets: Map<number, number> }>();
  private readonly buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  inc(name: string, labels?: Labels, value = 1): void {
    const key = keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(keyOf(name, labels), value);
  }

  observe(name: string, valueMs: number, labels?: Labels): void {
    const key = keyOf(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { count: 0, sum: 0, buckets: new Map(this.buckets.map((bucket) => [bucket, 0])) };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += valueMs;
    for (const bucket of this.buckets) {
      if (valueMs <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    }
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    for (const [key, histogram] of this.histograms) {
      const base = key.replace(/\}$/, '');
      const suffix = key.includes('{') ? ',' : '{';
      for (const bucket of this.buckets) {
        lines.push(`${base}${suffix}le="${bucket}"} ${histogram.buckets.get(bucket) ?? 0}`);
      }
      lines.push(`${base}${suffix}le="+Inf"} ${histogram.count}`);
      lines.push(`${base}_sum ${histogram.sum}`);
      lines.push(`${base}_count ${histogram.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new Metrics();
