export type Provider = "Compresto" | "Tinify";

export type OutputPolicy = "Subdirectory" | "Overwrite" | "CustomDirectory";

export type QueueSource = "manual" | "watch";

export type Language = "zh" | "en";

export interface AppConfig {
  comprestoApiKey: string;
  tinifyApiKey: string;
  tinifyCompressionCount?: number | null;
  tinifyLastCheckedAt?: string | null;
  comprestoKeys: ApiKeyEntry[];
  tinifyKeys: ApiKeyEntry[];
  activeComprestoKeyId?: string | null;
  activeTinifyKeyId?: string | null;
  watchFolderEnabled: boolean;
  watchFolderPath?: string | null;
  watchFolders: WatchFolderConfig[];
  keepAwakeDuringCompression: boolean;
  preserveComfyWorkflow: boolean;
  language: Language;
}

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  lastCheckedAt?: string | null;
  quotaExhausted?: boolean;
}

export interface ImageFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  isCompressed: boolean;
}

export interface WatchFolderConfig {
  id: string;
  path: string;
  enabled: boolean;
  lastScannedAt?: string | null;
  lastError?: string | null;
}

export interface WatchFolderScan {
  folder: string;
  allFiles: number;
  supportedFiles: number;
  compressedFiles: number;
  uncompressedFiles: number;
  files: ImageFile[];
}

export interface WatchFolderSummary extends WatchFolderConfig {
  allFiles: number;
  supportedFiles: number;
  compressedFiles: number;
  uncompressedFiles: number;
  processingFiles: number;
  failedFiles: number;
  queuedFiles: number;
}

export interface QueueItem extends ImageFile {
  id: string;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  selected: boolean;
  sources?: QueueSource[];
  outputPath?: string;
  compressedSize?: number;
  savingsPercent?: number;
  error?: string;
}

export interface CompressOptions {
  quality: number;
  format: string;
  maxWidth?: number | null;
  maxHeight?: number | null;
  preserveMetadata: boolean;
  preserveComfyWorkflow: boolean;
}

export interface UsageResult {
  provider: Provider;
  status: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  lastCheckedAt: string;
  message: string;
}

export interface CompressResult {
  sourcePath: string;
  outputPath: string;
  originalSize: number;
  compressedSize: number;
  savingsPercent: number;
  provider: Provider;
  usage?: UsageResult | null;
  skipped: boolean;
  message: string;
}
