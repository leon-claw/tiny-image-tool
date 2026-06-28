import type { AppConfig, CompressOptions, Language, Provider } from "./types";

export const DEFAULT_LANGUAGE: Language = "zh";
export const DEFAULT_PROVIDER: Provider = "Tinify";

export const defaultConfig: AppConfig = {
  comprestoApiKey: "",
  tinifyApiKey: "",
  tinifyCompressionCount: null,
  tinifyLastCheckedAt: null,
  comprestoKeys: [],
  tinifyKeys: [],
  activeComprestoKeyId: null,
  activeTinifyKeyId: null,
  watchFolderEnabled: false,
  watchFolderPath: null,
  watchFolders: [],
  keepAwakeDuringCompression: true,
  preserveComfyWorkflow: true,
  language: DEFAULT_LANGUAGE,
};

export const defaultOptions: CompressOptions = {
  quality: 80,
  format: "same",
  maxWidth: null,
  maxHeight: null,
  preserveMetadata: false,
  preserveComfyWorkflow: true,
};

export function optionsFromConfig(config: AppConfig, options: CompressOptions = defaultOptions): CompressOptions {
  return {
    ...options,
    preserveComfyWorkflow: config.preserveComfyWorkflow ?? true,
  };
}
