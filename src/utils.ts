import type { ApiKeyEntry, ImageFile, Provider, QueueItem, QueueSource } from "./types";

export type StatusFilter = "default" | "queued" | "processing" | "failed" | "done" | "cancelled";

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
  const amount = value / 1000 ** index;
  const precision = index === 0 ? 0 : amount < 100 ? 1 : 0;
  return `${amount.toFixed(precision)} ${units[index]}`;
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function toQueueItems(files: ImageFile[], existing: QueueItem[]): QueueItem[] {
  const seen = new Set(existing.map((item) => item.path));
  return files
    .filter((file) => !seen.has(file.path))
    .map((file) => ({
      ...file,
      id: file.path,
      status: "queued" as const,
      selected: false,
      sources: ["manual"] as QueueSource[],
    }));
}

export function mergeQueueItems(
  files: ImageFile[],
  existing: QueueItem[],
  source: QueueSource,
): QueueItem[] {
  const incoming = new Map(files.map((file) => [file.path, file]));
  const updated = existing.map((item) => {
    if (!incoming.has(item.path)) return item;
    const sources = mergeSources(item.sources, source);
    incoming.delete(item.path);
    return { ...item, sources };
  });
  const additions = Array.from(incoming.values()).map((file) => ({
    ...file,
    id: file.path,
    status: "queued" as const,
    selected: false,
    sources: [source],
  }));
  return [...updated, ...additions];
}

export function queueHasSource(item: QueueItem, source: QueueSource): boolean {
  if (!item.sources?.length) return source === "manual";
  return item.sources.includes(source);
}

function mergeSources(sources: QueueSource[] | undefined, source: QueueSource): QueueSource[] {
  const next = sources?.length ? [...sources] : ["manual" as const];
  return next.includes(source) ? next : [...next, source];
}

export function totalBytes(items: QueueItem[], key: "size" | "compressedSize"): number {
  return items.reduce((sum, item) => sum + (item[key] ?? 0), 0);
}

export function prioritizeQueueByStatus(items: QueueItem[], filter: StatusFilter): QueueItem[] {
  if (filter === "default") return items;

  const pinned: QueueItem[] = [];
  const rest: QueueItem[] = [];
  for (const item of items) {
    if (queueStatus(item) === filter) {
      pinned.push(item);
    } else {
      rest.push(item);
    }
  }
  return [...pinned, ...rest];
}

export function queueStatus(item: QueueItem): Exclude<StatusFilter, "default"> {
  if (item.isCompressed || item.status === "done") return "done";
  return item.status;
}

export function keyUsageMeta(
  provider: Provider,
  entry: ApiKeyEntry,
  labels: KeyUsageLabels = zhKeyUsageLabels,
): { text: string; tone: "neutral" | "used" | "remaining" | "exhausted" } {
  if (entry.quotaExhausted) return { text: labels.exhausted, tone: "exhausted" };
  if (provider === "Compresto") {
    if (entry.remaining != null) return { text: labels.remaining(entry.remaining), tone: "remaining" };
    if (entry.used != null) return { text: labels.used(entry.used), tone: "used" };
    return { text: labels.noUsage, tone: "neutral" };
  }
  if (entry.used != null) return { text: labels.used(entry.used), tone: "used" };
  if (entry.remaining != null) return { text: labels.remaining(entry.remaining), tone: "remaining" };
  return { text: labels.noUsage, tone: "neutral" };
}

export type KeyUsageLabels = {
  exhausted: string;
  noUsage: string;
  remaining: (count: number) => string;
  used: (count: number) => string;
};

const zhKeyUsageLabels: KeyUsageLabels = {
  exhausted: "已耗尽",
  noUsage: "—",
  remaining: (count) => `余 ${count}`,
  used: (count) => `用 ${count}`,
};
