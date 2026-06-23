import type { ImageFile, QueueItem } from "./types";

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
    }));
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
