import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ChevronRight,
  CheckCircle2,
  CircleDot,
  FileImage,
  FolderOpen,
  Gauge,
  KeyRound,
  Layers3,
  ListTree,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Settings as SettingsIcon,
  Trash2,
  X,
  Square,
} from "lucide-react";
import type {
  AppConfig,
  ApiKeyEntry,
  CompressOptions,
  CompressResult,
  ImageFile,
  Language,
  OutputPolicy,
  Provider,
  QueueItem,
  UsageResult,
  WatchFolderConfig,
  WatchFolderScan,
  WatchFolderSummary,
} from "./types";
import appIcon from "./assets/app-icon.png";
import { DEFAULT_LANGUAGE, DEFAULT_PROVIDER, defaultConfig, defaultOptions, optionsFromConfig } from "./defaults";
import { createTranslator, normalizeLanguage, type Translator } from "./i18n";
import {
  formatBytes,
  formatDateTime,
  keyUsageMeta,
  mergeQueueItems,
  queueHasSource,
  prioritizeQueueByStatus,
  totalBytes,
  type KeyUsageLabels,
  type StatusFilter,
} from "./utils";

const MAX_PARALLEL_COMPRESSIONS = 5;
const WATCH_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const WATCH_NEW_FILE_DEBOUNCE_MS = 1600;
const defaultTranslator = createTranslator(DEFAULT_LANGUAGE);

type ToastTone = "info" | "success" | "warning" | "error";
type WatchScanReason = "focus" | "timer" | "new-file" | "manual" | "enabled";
type AppView = "workbench" | "watch-folders" | "settings";

type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};

function App() {
  const [activeProvider, setActiveProvider] = useState<Provider>(DEFAULT_PROVIDER);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [usage, setUsage] = useState<Record<Provider, UsageResult | null>>({
    Compresto: null,
    Tinify: null,
  });
  const [options, setOptions] = useState<CompressOptions>(defaultOptions);
  const [outputPolicy, setOutputPolicy] = useState<OutputPolicy>("Subdirectory");
  const [customOutputDir, setCustomOutputDir] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPauseRequested, setIsPauseRequested] = useState(false);
  const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
  const [isWatchScanning, setIsWatchScanning] = useState(false);
  const [watchScans, setWatchScans] = useState<Record<string, WatchFolderScan & { lastScannedAt: string; lastError?: string | null }>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("default");
  const [view, setView] = useState<AppView>("workbench");
  const [activeWatchFolderId, setActiveWatchFolderId] = useState<string | null>(null);
  const [notice, setNotice] = useState(defaultTranslator("notice.ready"));
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const language = normalizeLanguage(config.language);
  const t = useMemo(() => createTranslator(language), [language]);
  const pauseRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const configSaveRef = useRef<Promise<AppConfig | null>>(Promise.resolve(null));
  const configSaveVersionRef = useRef(0);
  const configRef = useRef<AppConfig>(defaultConfig);
  const queueRef = useRef<QueueItem[]>([]);
  const isRunningRef = useRef(false);
  const optionsRef = useRef<CompressOptions>(defaultOptions);
  const outputPolicyRef = useRef<OutputPolicy>("Subdirectory");
  const customOutputDirRef = useRef("");
  const activeProviderRef = useRef<Provider>(DEFAULT_PROVIDER);
  const tRef = useRef<Translator>(defaultTranslator);
  const viewRef = useRef<AppView>("workbench");
  const activeWatchFolderIdRef = useRef<string | null>(null);
  const watchScanTimerRef = useRef<number | null>(null);
  const watchScanInFlightRef = useRef(false);
  const pendingWatchScanFoldersRef = useRef<Set<string> | null>(null);
  const autoRunAfterCurrentBatchRef = useRef(false);
  const currentRunSourceRef = useRef<"manual" | "watch" | null>(null);
  const activeCompressionRunIdRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  const activeWatchFolder = useMemo(
    () => watchFoldersFromConfig(config).find((folder) => folder.id === activeWatchFolderId) ?? null,
    [activeWatchFolderId, config],
  );
  const visibleQueue = useMemo(
    () =>
      activeWatchFolder
        ? queue.filter((item) => isPathInFolder(item.path, activeWatchFolder.path))
        : queue.filter((item) => queueHasSource(item, "manual")),
    [activeWatchFolder, queue],
  );
  const stats = useMemo(() => {
    const original = totalBytes(visibleQueue, "size");
    const compressed = totalBytes(visibleQueue, "compressedSize");
    const done = visibleQueue.filter((item) => item.status === "done").length;
    const failed = visibleQueue.filter((item) => item.status === "failed").length;
    const already = visibleQueue.filter((item) => item.isCompressed).length;
    const selected = visibleQueue.filter((item) => item.selected).length;
    return { original, compressed, done, failed, already, selected };
  }, [visibleQueue]);

  const displayQueue = useMemo(
    () => prioritizeQueueByStatus(visibleQueue, statusFilter),
    [visibleQueue, statusFilter],
  );
  const watchFolderSummaries = useMemo(
    () => buildWatchFolderSummaries(config, watchScans, queue),
    [config, queue, watchScans],
  );

  useEffect(() => {
    void loadConfig();
    const unlisten = listen("tauri://drag-drop", (event) => {
      const payload = event.payload as { paths?: string[] };
      if (Array.isArray(payload.paths)) {
        void addPaths(payload.paths);
      }
    });
    const unlistenWatch = listen("watch-folder-changed", (event) => {
      const payload = event.payload as { folder?: string };
      scheduleWatchScan("new-file", WATCH_NEW_FILE_DEBOUNCE_MS, payload.folder);
    });
    const intervalId = window.setInterval(() => {
      scheduleWatchScan("timer");
    }, WATCH_SCAN_INTERVAL_MS);
    const handleFocus = () => scheduleWatchScan("focus");
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleWatchScan("focus");
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      if (watchScanTimerRef.current) {
        window.clearTimeout(watchScanTimerRef.current);
      }
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void unlisten.then((dispose) => dispose());
      void unlistenWatch.then((dispose) => dispose());
      void invoke("stop_folder_watch");
    };
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    outputPolicyRef.current = outputPolicy;
  }, [outputPolicy]);

  useEffect(() => {
    customOutputDirRef.current = customOutputDir;
  }, [customOutputDir]);

  useEffect(() => {
    activeProviderRef.current = activeProvider;
  }, [activeProvider]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    setOptions((current) => optionsFromConfig(config, current));
  }, [config.preserveComfyWorkflow]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    activeWatchFolderIdRef.current = activeWatchFolderId;
  }, [activeWatchFolderId]);

  useEffect(() => {
    const folders = enabledWatchFolders(config).map((folder) => folder.path);
    if (!folders.length) {
      void invoke("stop_folder_watch");
      return;
    }

    void invoke("start_folder_watch", { folders })
      .then(() => scheduleWatchScan("enabled", 250))
      .catch((error) => showToast(String(error), "error"));

    return () => {
      void invoke("stop_folder_watch");
    };
  }, [config.watchFolders, config.watchFolderEnabled, config.watchFolderPath]);

  function msg(...args: Parameters<Translator>) {
    return tRef.current(...args);
  }

  function showToast(message: string, tone: ToastTone = "info") {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast({ id: Date.now(), message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }

  async function loadConfig() {
    try {
      const loaded = await invoke<AppConfig>("load_config");
      setConfig(loaded);
      setUsage(usageFromConfig(loaded));
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function saveConfig(
    nextConfig: AppConfig = config,
    message = msg("toast.configSaved"),
    version?: number,
  ): Promise<AppConfig | null> {
    try {
      const saved = await invoke<AppConfig>("save_config", { config: nextConfig });
      if (version == null || version === configSaveVersionRef.current) {
        setConfig(saved);
        setUsage(usageFromConfig(saved));
        setNotice(message);
      }
      return saved;
    } catch (error) {
      showToast(String(error), "error");
      return null;
    }
  }

  async function addPaths(paths: string[]) {
    try {
      const files = await invoke<ImageFile[]>("scan_paths", { paths });
      updateQueue((current) => mergeQueueItems(files, current, "manual"));
      setNotice(msg("toast.filesLoaded", { count: files.length }));
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length) void addPaths(paths);
  }

  async function chooseFolder() {
    const selected = await open({ multiple: true, directory: true });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length) void addPaths(paths);
  }

  async function chooseOutputDir() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      setCustomOutputDir(selected);
      setOutputPolicy("CustomDirectory");
    }
  }

  async function chooseWatchFolders() {
    const selected = await open({ multiple: true, directory: true });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) return;

    const current = watchFoldersFromConfig(configRef.current);
    const existingPaths = new Set(current.map((folder) => normalizePathForCompare(folder.path)));
    const additions = paths
      .filter((path) => !existingPaths.has(normalizePathForCompare(path)))
      .map((path) => createWatchFolder(path));

    if (!additions.length) {
      showToast(msg("toast.watchFolderDuplicate"), "warning");
      return;
    }

    const nextFolders = [...current, ...additions];
    persistWatchFolders(nextFolders, msg("toast.watchFolderAdded", { count: additions.length }));
    setView("watch-folders");
    setTimeout(() => scanWatchedFolders("manual", additions.map((folder) => folder.path)), 0);
  }

  function persistWatchFolders(folders: WatchFolderConfig[], message: string) {
    persistKeyChange(configWithWatchFolders(configRef.current, folders), message);
  }

  function toggleWatchFolder(id: string, enabled: boolean) {
    const folders = watchFoldersFromConfig(configRef.current).map((folder) =>
      folder.id === id ? { ...folder, enabled } : folder,
    );
    persistWatchFolders(folders, enabled ? msg("toast.watchFolderEnabled") : msg("toast.watchFolderPaused"));
    stopWatchRunIfNoEnabledFolders(folders);
  }

  function removeWatchFolder(id: string) {
    const folder = watchFoldersFromConfig(configRef.current).find((candidate) => candidate.id === id);
    const folders = watchFoldersFromConfig(configRef.current).filter((candidate) => candidate.id !== id);
    persistWatchFolders(folders, msg("toast.watchFolderRemoved"));
    setWatchScans((current) => {
      if (!folder) return current;
      const next = { ...current };
      delete next[folder.path];
      return next;
    });
    if (activeWatchFolderId === id) {
      setActiveWatchFolderId(null);
    }
    stopWatchRunIfNoEnabledFolders(folders);
  }

  function openWatchFolderDetail(id: string) {
    const folder = watchFoldersFromConfig(configRef.current).find((candidate) => candidate.id === id);
    if (!folder) return;
    setActiveWatchFolderId(id);
    setView("workbench");
    void scanWatchedFolders("manual", [folder.path]);
  }

  function toggleKeepAwake(enabled: boolean) {
    persistKeyChange(
      { ...configRef.current, keepAwakeDuringCompression: enabled },
      msg("settings.keepAwakeSaved", { state: enabled ? msg("settings.enabled") : msg("settings.disabled") }),
    );
  }

  function togglePreserveComfyWorkflow(enabled: boolean) {
    setOptions((current) => ({ ...current, preserveComfyWorkflow: enabled }));
    persistKeyChange(
      { ...configRef.current, preserveComfyWorkflow: enabled },
      msg("settings.comfySaved", { state: enabled ? msg("settings.enabled") : msg("settings.disabled") }),
    );
  }

  function selectLanguage(language: Language) {
    const nextT = createTranslator(language);
    persistKeyChange(
      { ...configRef.current, language },
      nextT("settings.languageSaved", { language: language === "en" ? "English" : "中文" }),
    );
  }

  async function refreshUsage(target: Provider = activeProvider) {
    const targetKeyId = activeKeyId(config, target);
    if (!hasConfiguredApiKey(config, target)) {
      showToast(msg("toast.refreshUsageMissingKey", { provider: target }), "warning");
      return;
    }

    await configSaveRef.current;
    setIsRefreshingUsage(true);
    try {
      const result = await invoke<UsageResult>("refresh_usage", { provider: target, keyId: targetKeyId });
      setUsage((current) =>
        activeKeyId(configRef.current, target) === targetKeyId ? { ...current, [target]: result } : current,
      );
      setConfig((current) => applyUsageToConfig(current, target, result, targetKeyId));
      showToast(msg("toast.usageRefreshed", { provider: target }), "success");
    } catch (error) {
      if (target === "Tinify" && isQuotaExceededMessage(error)) {
        void loadConfig();
      }
      setUsage((current) => ({
        ...current,
        [target]: {
          provider: target,
          status: "error",
          used: null,
          limit: null,
          remaining: null,
          lastCheckedAt: new Date().toISOString(),
          message: String(error),
        },
      }));
      showToast(String(error), "error");
    } finally {
      setIsRefreshingUsage(false);
    }
  }

  function scheduleWatchScan(reason: WatchScanReason, delay = 0, folder?: string) {
    if (folder) {
      if (!pendingWatchScanFoldersRef.current) {
        pendingWatchScanFoldersRef.current = new Set();
      }
      pendingWatchScanFoldersRef.current.add(folder);
    } else {
      pendingWatchScanFoldersRef.current = null;
    }
    if (watchScanTimerRef.current) {
      window.clearTimeout(watchScanTimerRef.current);
    }
    watchScanTimerRef.current = window.setTimeout(() => {
      watchScanTimerRef.current = null;
      const pending = pendingWatchScanFoldersRef.current;
      pendingWatchScanFoldersRef.current = null;
      void scanWatchedFolders(reason, pending ? [...pending] : undefined);
    }, delay);
  }

  async function scanWatchedFolders(reason: WatchScanReason, folderPaths?: string[]) {
    const currentConfig = configRef.current;
    const allFolders = reason === "manual" ? watchFoldersFromConfig(currentConfig) : enabledWatchFolders(currentConfig);
    const selectedPaths = folderPaths?.length
      ? new Set(folderPaths.map(normalizePathForCompare))
      : null;
    const folders = selectedPaths
      ? allFolders.filter((folder) => selectedPaths.has(normalizePathForCompare(folder.path)))
      : allFolders;
    if (!folders.length) return;

    if (watchScanInFlightRef.current) {
      scheduleWatchScan(reason, WATCH_NEW_FILE_DEBOUNCE_MS);
      return;
    }

    watchScanInFlightRef.current = true;
    setIsWatchScanning(true);
    try {
      let totalFiles = 0;
      let totalNewItems = 0;
      const runnablePaths = new Set<string>();

      for (const folder of folders) {
        try {
          const scan = await invoke<WatchFolderScan>("scan_watch_folder", { folder: folder.path });
          const checkedAt = new Date().toISOString();
          totalFiles += scan.files.length;
          scan.files.forEach((file) => runnablePaths.add(file.path));
          totalNewItems += scan.files.filter((file) => !queueRef.current.some((item) => item.path === file.path)).length;
          updateQueue((current) => mergeQueueItems(scan.files, current, "watch"));
          setWatchScans((current) => ({
            ...current,
            [folder.path]: { ...scan, lastScannedAt: checkedAt, lastError: null },
          }));
        } catch (error) {
          setWatchScans((current) => ({
            ...current,
            [folder.path]: {
              folder: folder.path,
              allFiles: 0,
              supportedFiles: 0,
              compressedFiles: 0,
              uncompressedFiles: 0,
              files: [],
              lastScannedAt: new Date().toISOString(),
              lastError: String(error),
            },
          }));
          showToast(msg("toast.scanFailed", { folder: folderName(folder.path), error: String(error) }), "error");
        }
      }
      if (reason === "manual") {
        showToast(totalNewItems ? msg("toast.newImagesFound", { count: totalNewItems }) : msg("toast.noNewImages"), "info");
      }
      if (viewRef.current === "watch-folders" || activeWatchFolderIdRef.current) {
        setNotice(msg("notice.watchScanned", { folders: folders.length, files: totalFiles }));
      }

      const runnable = runnableItems(queueRef.current).filter((item) => runnablePaths.has(item.path));
      if (!runnable.length) return;
      if (outputPolicyRef.current === "Overwrite") {
        showToast(msg("toast.watchNoOverwrite"), "warning");
        return;
      }
      const provider = activeProviderRef.current;
      if (!hasUsableApiKey(configRef.current, provider)) {
        showToast(msg("toast.watchMissingKey", { reason: apiKeyUnavailableMessage(configRef.current, provider, msg) }), "warning");
        return;
      }
      await runCompression(runnable, "watch");
    } catch (error) {
      showToast(String(error), "error");
    } finally {
      watchScanInFlightRef.current = false;
      setIsWatchScanning(false);
    }
  }

  async function startCompression() {
    const workspaceItems = activeWatchFolder
      ? queueRef.current.filter((item) => isPathInFolder(item.path, activeWatchFolder.path))
      : queueRef.current.filter((item) => queueHasSource(item, "manual"));
    const runnable = runnableItems(workspaceItems);
    if (!runnable.length) {
      showToast(workspaceItems.length ? msg("toast.noRunnable") : msg("toast.chooseFilesFirst"), "warning");
      return;
    }
    if (!hasUsableApiKey(config, activeProvider)) {
      showToast(apiKeyUnavailableMessage(config, activeProvider, msg), "warning");
      return;
    }
    if (outputPolicy === "CustomDirectory" && !customOutputDir) {
      showToast(msg("toast.chooseOutputDir"), "warning");
      return;
    }
    if (outputPolicy === "Overwrite" && !window.confirm(msg("confirm.overwrite"))) {
      return;
    }

    await runCompression(runnable, "manual");
  }

  async function runCompression(runnable: QueueItem[], source: "manual" | "watch") {
    if (!runnable.length) return;
    if (isRunningRef.current) {
      if (source === "watch") {
        autoRunAfterCurrentBatchRef.current = true;
      }
      return;
    }

    pauseRef.current = false;
    stopRequestedRef.current = false;
    setIsPauseRequested(false);
    isRunningRef.current = true;
    currentRunSourceRef.current = source;
    const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeCompressionRunIdRef.current = runId;
    setIsRunning(true);
    await configSaveRef.current;
    const keepAwakeStarted = await beginKeepAwakeIfNeeded();
    setNotice(
      msg("notice.running", {
        source: source === "watch" ? msg("source.watch") : msg("source.manual"),
        count: runnable.length,
        parallel: MAX_PARALLEL_COMPRESSIONS,
      }),
    );

    try {
      let nextIndex = 0;

      async function processItem(item: QueueItem) {
        if (source === "watch" && !isItemInEnabledWatchFolders(item, configRef.current)) {
          return;
        }
        await configSaveRef.current;
        const currentConfig = configRef.current;
        const itemProvider = activeProviderRef.current;
        const itemKeyId = activeKeyId(currentConfig, itemProvider);
        if (!hasUsableApiKey(currentConfig, itemProvider)) {
          updateQueue((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, status: "failed", error: apiKeyUnavailableMessage(currentConfig, itemProvider, msg) }
                : candidate,
            ),
          );
          return;
        }

        updateQueue((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, status: "processing", error: undefined } : candidate,
          ),
        );

        try {
          const result = await invoke<CompressResult>("compress_image", {
            path: item.path,
            provider: itemProvider,
            keyId: itemKeyId,
            runId,
            options: normalizeOptions(optionsRef.current),
            outputPolicy: outputPolicyRef.current,
            customOutputDir: customOutputDirRef.current || null,
          });

          if (stopRequestedRef.current) {
            updateQueue((current) =>
              current.map((candidate) =>
                candidate.id === item.id ? { ...candidate, status: "cancelled", error: msg("error.stopped") } : candidate,
              ),
            );
            return;
          }

          updateQueue((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    status: "done",
                    isCompressed: true,
                    outputPath: result.outputPath,
                    compressedSize: result.compressedSize,
                    savingsPercent: result.savingsPercent,
                  }
                : candidate,
            ),
          );

          if (result.usage) {
            setUsage((current) =>
              activeKeyId(configRef.current, result.provider) === itemKeyId
                ? { ...current, [result.provider]: result.usage ?? null }
                : current,
            );
            setConfig((current) => applyUsageToConfig(current, result.provider, result.usage as UsageResult, itemKeyId));
          }
          if (pauseRef.current) {
            return;
          }
        } catch (error) {
          if (itemProvider === "Tinify" && isQuotaExceededMessage(error)) {
            void loadConfig();
          }
          updateQueue((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? stopRequestedRef.current
                  ? { ...candidate, status: "cancelled", error: msg("error.stopped") }
                  : { ...candidate, status: "failed", error: String(error) }
                : candidate,
            ),
          );
        }
      }

      async function worker() {
        while (!pauseRef.current) {
          const item = runnable[nextIndex];
          nextIndex += 1;
          if (!item) return;
          if (source === "watch" && !isItemInEnabledWatchFolders(item, configRef.current)) {
            continue;
          }
          await processItem(item);
        }
      }

      const workerCount = Math.min(MAX_PARALLEL_COMPRESSIONS, runnable.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      await endKeepAwakeIfNeeded(keepAwakeStarted);
      await clearCompressionRun(runId);
    }

    isRunningRef.current = false;
    currentRunSourceRef.current = null;
    activeCompressionRunIdRef.current = null;
    setIsRunning(false);
    setIsPauseRequested(false);
    setNotice(
      stopRequestedRef.current
        ? msg("status.stopped")
        : pauseRef.current
          ? msg("status.paused")
          : msg("status.done"),
    );
    if (!pauseRef.current && autoRunAfterCurrentBatchRef.current) {
      autoRunAfterCurrentBatchRef.current = false;
      const pending = runnableItems(queueRef.current).filter((item) =>
        isItemInEnabledWatchFolders(item, configRef.current),
      );
      if (pending.length) {
        void runCompression(pending, "watch");
      }
    }
  }

  async function beginKeepAwakeIfNeeded(): Promise<boolean> {
    if (!configRef.current.keepAwakeDuringCompression) return false;
    try {
      await invoke("begin_power_assertion");
      return true;
    } catch (error) {
      showToast(msg("toast.keepAwakeStartFailed", { error: String(error) }), "warning");
      return false;
    }
  }

  async function endKeepAwakeIfNeeded(started: boolean) {
    if (!started) return;
    try {
      await invoke("end_power_assertion");
    } catch (error) {
      showToast(msg("toast.keepAwakeEndFailed", { error: String(error) }), "warning");
    }
  }

  function requestPause() {
    pauseRef.current = true;
    setIsPauseRequested(true);
    setNotice(msg("notice.pauseRequested"));
  }

  function requestImmediateStop() {
    if (!isRunningRef.current) return;
    stopRequestedRef.current = true;
    pauseRef.current = true;
    autoRunAfterCurrentBatchRef.current = false;
    setIsPauseRequested(true);
    setNotice(msg("notice.stopRequested"));
    updateQueue((current) =>
      current.map((item) =>
        item.status === "processing" ? { ...item, status: "cancelled", error: msg("error.stopped") } : item,
      ),
    );
    const runId = activeCompressionRunIdRef.current;
    if (runId) {
      void invoke("cancel_compression_run", { runId }).catch((error) => showToast(String(error), "error"));
    }
  }

  async function clearCompressionRun(runId: string) {
    try {
      await invoke("clear_compression_run", { runId });
    } catch {
      // Best effort cleanup; stale run ids only affect future runs if ids collide.
    }
  }

  function stopWatchRunIfNoEnabledFolders(folders: WatchFolderConfig[]) {
    if (currentRunSourceRef.current === "watch" && !folders.some((folder) => folder.enabled)) {
      pauseRef.current = true;
      autoRunAfterCurrentBatchRef.current = false;
      setIsPauseRequested(true);
      setNotice(msg("notice.watchPaused"));
    }
  }

  function persistKeyChange(nextConfig: AppConfig, message: string) {
    const previousConfig = configRef.current;
    setConfig(nextConfig);
    setUsage(usageFromConfig(nextConfig));
    const version = configSaveVersionRef.current + 1;
    configSaveVersionRef.current = version;
    configSaveRef.current = saveConfig(nextConfig, message, version).then((saved) => {
      if (!saved && version === configSaveVersionRef.current) {
        setConfig(previousConfig);
        setUsage(usageFromConfig(previousConfig));
      }
      return saved;
    });
    void configSaveRef.current;
  }

  function updateQueue(updater: (current: QueueItem[]) => QueueItem[]) {
    setQueue((current) => {
      const next = updater(current);
      queueRef.current = next;
      return next;
    });
  }

  function toggleSelected(id: string) {
    updateQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item)),
    );
  }

  function toggleAllSelected() {
    const visibleIds = new Set(visibleQueue.map((item) => item.id));
    const shouldSelect = stats.selected !== visibleQueue.length;
    updateQueue((current) =>
      current.map((item) => (visibleIds.has(item.id) ? { ...item, selected: shouldSelect } : item)),
    );
  }

  function removeSelected() {
    const visibleIds = new Set(visibleQueue.map((item) => item.id));
    updateQueue((current) => current.filter((item) => !(visibleIds.has(item.id) && item.selected)));
  }

  function removeOne(id: string) {
    updateQueue((current) => current.filter((item) => item.id !== id));
  }

  function selectProvider(provider: Provider) {
    activeProviderRef.current = provider;
    setActiveProvider(provider);
  }

  function renderSettingsPane(showRunBar: boolean) {
    const keyUsageLabels = {
      exhausted: t("apiKey.exhausted"),
      noUsage: t("apiKey.noUsage"),
      remaining: (count: number) => t("apiKey.remaining", { count }),
      used: (count: number) => t("apiKey.used", { count }),
    };

    return (
      <aside className="settings-pane">
        <div className="tabs">
          <button
            type="button"
            className={activeProvider === "Tinify" ? "active" : ""}
            onClick={() => selectProvider("Tinify")}
          >
            Tinify
          </button>
          <button
            type="button"
            className={activeProvider === "Compresto" ? "active" : ""}
            onClick={() => selectProvider("Compresto")}
          >
            Compresto
          </button>
        </div>

        {activeProvider === "Compresto" ? (
          <ComprestoSettings
            t={t}
            config={config}
            persistKeyChange={persistKeyChange}
            notify={showToast}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            usage={usage.Compresto}
            refreshUsage={() => refreshUsage("Compresto")}
            loading={isRefreshingUsage}
            keyUsageLabels={keyUsageLabels}
          />
        ) : (
          <TinifySettings
            t={t}
            config={config}
            persistKeyChange={persistKeyChange}
            notify={showToast}
            options={options}
            setOptions={setOptions}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            usage={usage.Tinify}
            refreshUsage={() => refreshUsage("Tinify")}
            loading={isRefreshingUsage}
            keyUsageLabels={keyUsageLabels}
          />
        )}

        {showRunBar ? (
          <footer className="run-bar">
            <button type="button" className="primary" onClick={startCompression} disabled={isRunning}>
              {isRunning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              {t("run.start")}
            </button>
            <button type="button" onClick={requestPause} disabled={!isRunning || isPauseRequested}>
              <Pause size={18} />
              {isPauseRequested ? t("run.pausing") : t("run.pause")}
            </button>
            <button type="button" className="danger" onClick={requestImmediateStop} disabled={!isRunning}>
              <Square size={17} />
              {t("run.stopNow")}
            </button>
          </footer>
        ) : null}
      </aside>
    );
  }

  return (
    <>
      <main className={view === "settings" ? "app-shell settings-only" : "app-shell"} data-provider={activeProvider.toLowerCase()}>
      <aside className="mode-rail">
        <div className="mode-brand">
          <div className="brand-sigil">
            <img src={appIcon} alt="" />
          </div>
          <div>
            <strong>Tiny Image Tool</strong>
            <span>{t("app.subtitle")}</span>
          </div>
        </div>
        <nav className="mode-nav" aria-label={t("nav.settings")}>
          <button
            type="button"
            className={view === "watch-folders" ? "active" : ""}
            onClick={() => setView("watch-folders")}
          >
            <ListTree size={17} />
            {t("nav.watchFolders")}
          </button>
          <button
            type="button"
            className={view === "workbench" ? "active" : ""}
            onClick={() => {
              setActiveWatchFolderId(null);
              setView("workbench");
            }}
          >
            <FileImage size={17} />
            {t("nav.workbench")}
          </button>
          <button
            type="button"
            className={view === "settings" ? "active" : ""}
            onClick={() => {
              setActiveWatchFolderId(null);
              setView("settings");
            }}
          >
            <SettingsIcon size={17} />
            {t("nav.settings")}
          </button>
        </nav>
      </aside>

      {view === "settings" ? (
        <SettingsPage
          t={t}
          language={language}
          config={config}
          selectLanguage={selectLanguage}
          toggleKeepAwake={toggleKeepAwake}
          togglePreserveComfyWorkflow={togglePreserveComfyWorkflow}
        />
      ) : view === "watch-folders" ? (
        <WatchFoldersPage
          t={t}
          summaries={watchFolderSummaries}
          isScanning={isWatchScanning}
          addFolders={chooseWatchFolders}
          scanAll={() => scanWatchedFolders("manual")}
          openFolder={openWatchFolderDetail}
          toggleFolder={toggleWatchFolder}
          removeFolder={removeWatchFolder}
          setAllEnabled={(enabled) => {
            const folders = watchFoldersFromConfig(configRef.current).map((folder) => ({ ...folder, enabled }));
            persistWatchFolders(folders, enabled ? msg("toast.allWatchFoldersEnabled") : msg("toast.allWatchFoldersPaused"));
            stopWatchRunIfNoEnabledFolders(folders);
          }}
        />
      ) : (
        <section className="file-pane">
        <header className="file-toolbar">
          <div className="brand-lockup">
            <div>
              <h1>{activeWatchFolder ? folderName(activeWatchFolder.path) : t("nav.workbench")}</h1>
              {activeWatchFolder ? (
                <div className="breadcrumb" aria-label={t("nav.watchFolders")}>
                  <button type="button" onClick={() => setView("watch-folders")}>
                    {t("nav.watchFolders")}
                  </button>
                  <ChevronRight size={14} />
                  <span>{folderName(activeWatchFolder.path)}</span>
                </div>
              ) : (
                <p>{notice}</p>
              )}
            </div>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={chooseFiles}>
              <FileImage size={17} />
              {t("toolbar.chooseFiles")}
            </button>
            <button type="button" onClick={chooseFolder}>
              <FolderOpen size={17} />
              {t("toolbar.chooseFolder")}
            </button>
            <button type="button" className="ghost" onClick={removeSelected} disabled={!stats.selected || isRunning}>
              <Trash2 size={17} />
              {t("toolbar.deleteSelected")}
            </button>
          </div>
        </header>

        <section className="summary-strip">
          <Metric label={t("metric.files")} value={String(visibleQueue.length)} detail={t("metric.selected", { count: stats.selected })} />
          <Metric label={t("metric.alreadyCompressed")} value={String(stats.already)} detail={t("metric.markerHit")} />
          <Metric label={t("metric.done")} value={String(stats.done)} detail={`${stats.failed} ${t("filter.failed")}`} />
          <Metric label={t("metric.originalSize")} value={formatBytes(stats.original)} detail={formatBytes(stats.compressed)} />
        </section>

        <section className="explorer">
          <div className="explorer-head">
            <label className="select-all">
              <input
                type="checkbox"
                checked={visibleQueue.length > 0 && stats.selected === visibleQueue.length}
                onChange={toggleAllSelected}
              />
              {t("explorer.assets")}
            </label>
            <label className="status-filter">
              {t("explorer.status")}
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="default">{t("filter.default")}</option>
                <option value="queued">{t("filter.queued")}</option>
                <option value="processing">{t("filter.processing")}</option>
                <option value="failed">{t("filter.failed")}</option>
                <option value="done">{t("filter.done")}</option>
                <option value="cancelled">{t("filter.cancelled")}</option>
              </select>
            </label>
            <span>{t("explorer.size")}</span>
            <span>{t("explorer.actions")}</span>
          </div>
          <div className="explorer-body">
            {displayQueue.length === 0 ? (
              <button
                type="button"
                className="empty-state"
                onClick={activeWatchFolder ? undefined : chooseFiles}
                disabled={Boolean(activeWatchFolder)}
              >
                <FileImage size={30} />
                <span>{activeWatchFolder ? t("empty.folder") : t("empty.workbench")}</span>
                <small>{activeWatchFolder ? t("empty.folderHint") : t("empty.workbenchHint")}</small>
              </button>
            ) : (
              displayQueue.map((item) => (
                <div className="file-row" key={item.id}>
                  <label className="file-cell">
                    <input type="checkbox" checked={item.selected} onChange={() => toggleSelected(item.id)} />
                    <FileImage size={18} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.path}</small>
                    </span>
                  </label>
                  <StatusBadge item={item} t={t} />
                  <span className="size-cell">
                    {formatBytes(item.size)}
                    {item.compressedSize ? <small>{formatBytes(item.compressedSize)}</small> : null}
                  </span>
                  <button className="icon" type="button" title={t("action.delete")} onClick={() => removeOne(item.id)} disabled={isRunning}>
                    <Trash2 size={16} />
                  </button>
                  {item.error ? <p className="row-error">{item.error}</p> : null}
                </div>
              ))
            )}
          </div>
        </section>
      </section>
      )}

      {view === "settings" ? null : renderSettingsPane(view === "workbench")}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} t={t} />
    </>
  );
}

function SettingsPage({
  t,
  language,
  config,
  selectLanguage,
  toggleKeepAwake,
  togglePreserveComfyWorkflow,
}: {
  t: Translator;
  language: Language;
  config: AppConfig;
  selectLanguage: (language: Language) => void;
  toggleKeepAwake: (enabled: boolean) => void;
  togglePreserveComfyWorkflow: (enabled: boolean) => void;
}) {
  const keepAwakeState = config.keepAwakeDuringCompression ? t("settings.enabled") : t("settings.disabled");
  const comfyState = config.preserveComfyWorkflow ? t("settings.enabled") : t("settings.disabled");
  const languageLabel = language === "en" ? t("settings.languageEn") : t("settings.languageZh");

  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <div className="settings-title-block">
          <div className="settings-hero-icon">
            <SettingsIcon size={21} />
          </div>
          <div>
            <span>{t("settings.general")}</span>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.description")}</p>
          </div>
        </div>
        <div className="settings-header-readout" aria-label={t("settings.general")}>
          <span>{languageLabel}</span>
          <span>{keepAwakeState}</span>
          <span>{comfyState}</span>
        </div>
      </header>

      <div className="settings-page-content">
        <aside className="settings-overview">
          <div>
            <span className="settings-overview-label">{t("settings.general")}</span>
            <h2>{t("settings.title")}</h2>
            <p>{t("settings.description")}</p>
          </div>
          <dl>
            <div>
              <dt>{t("settings.language")}</dt>
              <dd>{languageLabel}</dd>
            </div>
            <div>
              <dt>{t("settings.keepAwake")}</dt>
              <dd>{keepAwakeState}</dd>
            </div>
            <div>
              <dt>{t("settings.preserveComfy")}</dt>
              <dd>{comfyState}</dd>
            </div>
          </dl>
        </aside>

        <div className="settings-board">
          <section className="settings-card settings-card-primary">
            <div className="settings-card-heading">
              <div className="settings-card-icon">
                <SettingsIcon size={18} />
              </div>
              <div>
                <span>{t("settings.general")}</span>
                <h2>{t("settings.language")}</h2>
              </div>
            </div>
            <label className="settings-control-row">
              <span>
                <strong>{t("settings.language")}</strong>
                <small>{languageLabel}</small>
              </span>
              <select value={language} onChange={(event) => selectLanguage(event.target.value as Language)}>
                <option value="zh">{t("settings.languageZh")}</option>
                <option value="en">{t("settings.languageEn")}</option>
              </select>
            </label>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon dark">
                <Gauge size={18} />
              </div>
              <div>
                <span>{keepAwakeState}</span>
                <h2>{t("settings.keepAwake")}</h2>
              </div>
            </div>
            <label className="settings-switch-row">
              <span>
                <strong>{t("settings.keepAwake")}</strong>
                <small>{keepAwakeState}</small>
              </span>
              <input
                type="checkbox"
                checked={config.keepAwakeDuringCompression}
                onChange={(event) => toggleKeepAwake(event.target.checked)}
              />
            </label>
          </section>

          <section className="settings-card settings-card-wide">
            <div className="settings-card-heading">
              <div className="settings-card-icon blue">
                <Layers3 size={18} />
              </div>
              <div>
                <span>{comfyState}</span>
                <h2>{t("settings.preserveComfy")}</h2>
              </div>
            </div>
            <label className="settings-switch-row">
              <span>
                <strong>{t("settings.preserveComfy")}</strong>
                <small>{t("settings.comfyHint")}</small>
              </span>
              <input
                type="checkbox"
                checked={config.preserveComfyWorkflow}
                onChange={(event) => togglePreserveComfyWorkflow(event.target.checked)}
              />
            </label>
          </section>
        </div>
      </div>
    </section>
  );
}

function WatchFoldersPage({
  t,
  summaries,
  isScanning,
  addFolders,
  scanAll,
  openFolder,
  toggleFolder,
  removeFolder,
  setAllEnabled,
}: {
  t: Translator;
  summaries: WatchFolderSummary[];
  isScanning: boolean;
  addFolders: () => void;
  scanAll: () => void;
  openFolder: (id: string) => void;
  toggleFolder: (id: string, enabled: boolean) => void;
  removeFolder: (id: string) => void;
  setAllEnabled: (enabled: boolean) => void;
}) {
  const totalPending = summaries.reduce((sum, folder) => sum + folder.uncompressedFiles, 0);
  const totalProcessing = summaries.reduce((sum, folder) => sum + folder.processingFiles, 0);
  const totalFailed = summaries.reduce((sum, folder) => sum + folder.failedFiles, 0);
  const totalSupported = summaries.reduce((sum, folder) => sum + folder.supportedFiles, 0);
  const totalCompressed = summaries.reduce((sum, folder) => sum + folder.compressedFiles, 0);
  const totalFiles = summaries.reduce((sum, folder) => sum + folder.allFiles, 0);
  const enabledCount = summaries.filter((folder) => folder.enabled).length;

  return (
      <section className="watch-page">
        <header className="watch-page-header">
          <div className="brand-lockup">
            <div>
              <h1>{t("watch.title")}</h1>
              <p>{t("watch.description")}</p>
            </div>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={addFolders}>
              <FolderOpen size={17} />
              {t("watch.addFolder")}
            </button>
            <button type="button" className="refresh-button" onClick={scanAll} disabled={!summaries.length || isScanning}>
              {isScanning ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
              {t("watch.scanAll")}
            </button>
            <button type="button" className="ghost" onClick={() => setAllEnabled(enabledCount !== summaries.length)}>
              {enabledCount === summaries.length && summaries.length ? t("watch.pauseAll") : t("watch.resumeAll")}
            </button>
          </div>
        </header>

        <section className="watch-summary-grid">
          <Metric label={t("watch.enabledCount")} value={String(enabledCount)} detail={`${summaries.length} ${t("watch.folders")}`} />
          <Metric label={t("watch.pending")} value={String(totalPending)} detail={t("watch.uncompressedImages")} />
          <Metric label={t("watch.processing")} value={String(totalProcessing)} detail={t("watch.globalQueue")} />
          <Metric label={t("watch.failed")} value={String(totalFailed)} detail={t("watch.recentTasks")} />
        </section>

        <details className="watch-extra-stats">
          <summary>
            {t("watch.moreStats", { all: totalFiles, supported: totalSupported, compressed: totalCompressed, folders: summaries.length })}
          </summary>
          <div className="watch-summary-grid compact">
            <Metric label={t("watch.folders")} value={String(summaries.length)} detail={`${enabledCount} ${t("settings.enabled")}`} />
            <Metric label={t("watch.allFiles")} value={String(totalFiles)} detail={t("watch.currentLevel")} />
            <Metric label={t("watch.supported")} value={String(totalSupported)} detail="jpg/png/webp" />
            <Metric label={t("watch.compressed")} value={String(totalCompressed)} detail={t("watch.outputHit")} />
          </div>
        </details>

        <section className="watch-table">
          <div className="watch-table-scroll">
            <div className="watch-table-head">
              <span>{t("watch.folder")}</span>
              <span>{t("watch.state")}</span>
              <span>{t("watch.all")}</span>
              <span>{t("watch.uncompressed")}</span>
              <span>{t("watch.compressed")}</span>
              <span>{t("watch.processing")}</span>
              <span>{t("watch.failed")}</span>
              <span className="watch-sticky-col">{t("explorer.actions")}</span>
            </div>
            {summaries.length === 0 ? (
              <div className="empty-state">
                <FolderOpen size={30} />
                <span>{t("watch.empty")}</span>
                <button type="button" onClick={addFolders}>
                  <Plus size={16} />
                  {t("watch.addFolder")}
                </button>
              </div>
            ) : (
              summaries.map((folder) => (
                <div className="watch-folder-row" key={folder.id}>
                  <button type="button" className="watch-folder-main" onClick={() => openFolder(folder.id)}>
                    <FolderOpen size={18} />
                    <span>
                      <strong>{folderName(folder.path)}</strong>
                      <small>{folder.path}</small>
                      <small>
                        {t("watch.lastScan", { time: folder.lastScannedAt ? formatDateTime(folder.lastScannedAt) : t("usage.never") })}
                        {folder.lastError ? ` · ${folder.lastError}` : ""}
                      </small>
                    </span>
                  </button>
                  <span className={folder.enabled ? "watch-state active" : "watch-state"}>
                    {folder.enabled ? t("watch.running") : t("watch.paused")}
                  </span>
                  <b>{folder.allFiles}</b>
                  <b>{folder.uncompressedFiles}</b>
                  <b>{folder.compressedFiles}</b>
                  <b>{folder.processingFiles}</b>
                  <b>{folder.failedFiles}</b>
                  <div className="watch-row-actions watch-sticky-col">
                    <button className="icon" type="button" title={t("action.enter")} onClick={() => openFolder(folder.id)}>
                      <ChevronRight size={16} />
                    </button>
                    <button className="icon" type="button" title={folder.enabled ? t("action.pause") : t("action.resume")} onClick={() => toggleFolder(folder.id, !folder.enabled)}>
                      {folder.enabled ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <button className="icon" type="button" title={t("action.remove")} onClick={() => removeFolder(folder.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </section>
  );
}

function ComprestoSettings({
  t,
  config,
  persistKeyChange,
  notify,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  usage,
  refreshUsage,
  loading,
  keyUsageLabels,
}: SettingsProps) {
  return (
    <div className="settings-content">
      <Panel title={t("panel.apiKey")} icon={<KeyRound size={18} />}>
        <ApiKeyManager provider="Compresto" config={config} persistKeyChange={persistKeyChange} notify={notify} t={t} keyUsageLabels={keyUsageLabels} />
      </Panel>
      <OutputPanel {...{ t, outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir }} />
      <UsagePanel provider="Compresto" result={usage} onRefresh={refreshUsage} loading={loading} t={t} />
    </div>
  );
}

function TinifySettings({
  t,
  config,
  persistKeyChange,
  notify,
  options,
  setOptions,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  usage,
  refreshUsage,
  loading,
  keyUsageLabels,
}: SettingsProps & {
  options: CompressOptions;
  setOptions: (options: CompressOptions) => void;
}) {
  return (
    <div className="settings-content">
      <Panel title={t("panel.apiKey")} icon={<KeyRound size={18} />}>
        <ApiKeyManager provider="Tinify" config={config} persistKeyChange={persistKeyChange} notify={notify} t={t} keyUsageLabels={keyUsageLabels} />
      </Panel>

      <Panel title={t("panel.tinifyOptions")} icon={<Layers3 size={18} />}>
        <label>
          {t("tinify.format")}
          <select value={options.format} onChange={(event) => setOptions({ ...options, format: event.target.value })}>
            <option value="same">{t("tinify.formatSame")}</option>
            <option value="jpg">JPG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
          </select>
        </label>
        <div className="split">
          <label>
            {t("tinify.maxWidth")}
            <input
              type="number"
              min="1"
              placeholder={t("tinify.auto")}
              value={options.maxWidth ?? ""}
              onChange={(event) => setOptions({ ...options, maxWidth: optionalNumber(event.target.value) })}
            />
          </label>
          <label>
            {t("tinify.maxHeight")}
            <input
              type="number"
              min="1"
              placeholder={t("tinify.auto")}
              value={options.maxHeight ?? ""}
              onChange={(event) => setOptions({ ...options, maxHeight: optionalNumber(event.target.value) })}
            />
          </label>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={options.preserveMetadata}
            onChange={(event) => setOptions({ ...options, preserveMetadata: event.target.checked })}
          />
          {t("tinify.preserveMetadata")}
        </label>
      </Panel>

      <OutputPanel {...{ t, outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir }} />
      <UsagePanel provider="Tinify" result={usage} onRefresh={refreshUsage} loading={loading} t={t} />
    </div>
  );
}

type SettingsProps = {
  t: Translator;
  config: AppConfig;
  persistKeyChange: (config: AppConfig, message: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
  usage: UsageResult | null;
  refreshUsage: () => void;
  loading: boolean;
  keyUsageLabels: KeyUsageLabels;
};

function ApiKeyManager({
  provider,
  config,
  persistKeyChange,
  notify,
  t,
  keyUsageLabels,
}: {
  provider: Provider;
  config: AppConfig;
  persistKeyChange: (config: AppConfig, message: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
  t: Translator;
  keyUsageLabels: KeyUsageLabels;
}) {
  const [draftKey, setDraftKey] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const keys = providerKeys(config, provider);
  const activeId = activeKeyId(config, provider);

  function addKey() {
    const key = draftKey.trim();
    if (!key) return;
    if (hasDuplicateKey(keys, key)) {
      notify(t("key.duplicate", { provider }), "error");
      return;
    }

    const entry: ApiKeyEntry = {
      id: `${provider.toLowerCase()}-${Date.now()}`,
      label: maskKey(key),
      key,
      used: null,
      limit: null,
      remaining: null,
      lastCheckedAt: null,
      quotaExhausted: false,
    };
    persistKeyChange(
      setProviderKeys(
        setActiveKeyId(config, provider, entry.id),
        provider,
        [...keys, entry],
      ),
      t("key.added", { provider }),
    );
    setDraftKey("");
  }

  function activateKey(id: string) {
    persistKeyChange(setActiveKeyId(config, provider, id), t("key.switched", { provider }));
  }

  function removeKey(entry: ApiKeyEntry) {
    const nextKeys = keys.filter((key) => key.id !== entry.id);
    const nextConfig = setProviderKeys(config, provider, nextKeys);
    persistKeyChange(
      setActiveKeyId(nextConfig, provider, nextKeys[0]?.id ?? null),
      t("key.deleted", { provider }),
    );
    setPendingDelete(null);
  }

  return (
    <>
      <div className="key-manager">
        <div className="key-list">
          {keys.length === 0 ? (
            <div className="key-empty">{t("key.empty")}</div>
          ) : (
            keys.map((entry, index) => (
              <div className={entry.id === activeId ? "key-row active" : "key-row"} key={entry.id}>
                <button type="button" className="key-main" onClick={() => activateKey(entry.id)}>
                  <CircleDot size={14} />
                  <span>
                    <strong>{entry.label || `Key ${index + 1}`}</strong>
                    <small>{entry.lastCheckedAt ? formatDateTime(entry.lastCheckedAt) : t("usage.never")}</small>
                  </span>
                  <b className={`key-usage ${keyUsageMeta(provider, entry, keyUsageLabels).tone}`}>
                    {keyUsageMeta(provider, entry, keyUsageLabels).text}
                  </b>
                </button>
                <button className="icon" type="button" title={t("key.deleteTitle")} onClick={() => setPendingDelete(entry)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}
        </div>
        <label>
          {t("key.addNew")}
          <input
            type="password"
            value={draftKey}
            placeholder={provider === "Compresto" ? "X-API-Key" : "Tinify API key"}
            onChange={(event) => setDraftKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addKey();
            }}
          />
        </label>
        <button type="button" onClick={addKey} disabled={!draftKey.trim()}>
          <Plus size={16} />
          {t("key.addAndSave")}
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("key.deleteTitle")}
        message={t("key.deleteConfirm", { provider, label: pendingDelete?.label ?? "" })}
        confirmText={t("key.deleteConfirmButton")}
        cancelText={t("modal.cancel")}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) removeKey(pendingDelete);
        }}
      />
    </>
  );
}

function OutputPanel({
  t,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
}: {
  t: Translator;
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
}) {
  return (
    <Panel title={t("panel.output")} icon={<FolderOpen size={18} />}>
      <select value={outputPolicy} onChange={(event) => setOutputPolicy(event.target.value as OutputPolicy)}>
        <option value="Subdirectory">{t("output.subdirectory")}</option>
        <option value="CustomDirectory">{t("output.custom")}</option>
        <option value="Overwrite">{t("output.overwrite")}</option>
      </select>
      <button className="ghost" type="button" onClick={chooseOutputDir}>
        <FolderOpen size={16} />
        {t("output.chooseDir")}
      </button>
      <p className="hint">{outputPolicy === "CustomDirectory" ? customOutputDir || t("output.noDir") : "compressed/"}</p>
    </Panel>
  );
}

function UsagePanel({
  provider,
  result,
  onRefresh,
  loading,
  t,
}: {
  provider: Provider;
  result: UsageResult | null;
  onRefresh: () => void;
  loading: boolean;
  t: Translator;
}) {
  return (
    <Panel title={t("panel.usage")} icon={<Gauge size={18} />}>
      <div className="usage-card">
        <strong>{provider}</strong>
        <dl>
          <dt>{t("usage.used")}</dt>
          <dd>{result?.used ?? "—"}</dd>
          <dt>{t("usage.limit")}</dt>
          <dd>{result?.limit ?? "—"}</dd>
          <dt>{t("usage.remaining")}</dt>
          <dd>{result?.remaining ?? "—"}</dd>
        </dl>
        <p>{result ? `${formatDateTime(result.lastCheckedAt)} · ${result.message}` : t("usage.never")}</p>
      </div>
      <button type="button" className="refresh-button" onClick={onRefresh} disabled={loading}>
        {loading ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
        {t("usage.refresh")}
      </button>
    </Panel>
  );
}

function Toast({ toast, onClose, t }: { toast: ToastMessage | null; onClose: () => void; t: Translator }) {
  if (!toast) return null;

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      {toast.tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <p>{toast.message}</p>
      <button className="icon toast-close" type="button" title={t("toast.close")} onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div>
          <h2 id="confirm-dialog-title">{title}</h2>
          <p>{message}</p>
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            {cancelText}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-title">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function StatusBadge({ item, t }: { item: QueueItem; t: Translator }) {
  if (item.isCompressed || item.status === "done") {
    return (
      <span className="badge done">
        <CheckCircle2 size={14} />
        {t("badge.done")}
      </span>
    );
  }
  if (item.status === "failed") {
    return (
      <span className="badge failed" title={item.error}>
        <AlertCircle size={14} />
        {t("badge.failed")}
      </span>
    );
  }
  if (item.status === "processing") {
    return (
      <span className="badge processing">
        <Loader2 className="spin" size={14} />
        {t("badge.processing")}
      </span>
    );
  }
  return <span className="badge">{t("badge.queued")}</span>;
}

function optionalNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOptions(options: CompressOptions): CompressOptions {
  return {
    ...options,
    maxWidth: options.maxWidth ?? null,
    maxHeight: options.maxHeight ?? null,
  };
}

function runnableItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (item) => !item.isCompressed && (item.status === "queued" || item.status === "failed" || item.status === "cancelled"),
  );
}

function providerKeys(config: AppConfig, provider: Provider): ApiKeyEntry[] {
  return provider === "Compresto" ? config.comprestoKeys ?? [] : config.tinifyKeys ?? [];
}

function activeKeyId(config: AppConfig, provider: Provider): string | null {
  return provider === "Compresto"
    ? config.activeComprestoKeyId ?? null
    : config.activeTinifyKeyId ?? null;
}

function activeKey(config: AppConfig, provider: Provider): ApiKeyEntry | undefined {
  return providerKeys(config, provider).find((entry) => entry.id === activeKeyId(config, provider));
}

function hasUsableApiKey(config: AppConfig, provider: Provider): boolean {
  const entry = activeKey(config, provider);
  if (entry?.quotaExhausted) return false;
  return hasConfiguredApiKey(config, provider);
}

function hasConfiguredApiKey(config: AppConfig, provider: Provider): boolean {
  const activeValue = activeKey(config, provider)?.key.trim();
  const legacyValue = provider === "Compresto" ? config.comprestoApiKey.trim() : config.tinifyApiKey.trim();
  return Boolean(activeValue || (legacyValue && !isMaskedSecret(legacyValue)));
}

function apiKeyUnavailableMessage(config: AppConfig, provider: Provider, t: Translator): string {
  const entry = activeKey(config, provider);
  if (entry?.quotaExhausted) {
    return t("apiKey.unavailableExhausted", { provider });
  }
  return t("apiKey.unavailableMissing", { provider });
}

function hasDuplicateKey(keys: ApiKeyEntry[], value: string): boolean {
  const normalized = value.trim();
  const masked = maskKey(normalized);
  return keys.some((entry) => {
    const savedKey = entry.key.trim();
    return savedKey === normalized || savedKey === masked || entry.label === masked;
  });
}

function isQuotaExceededMessage(value: unknown): boolean {
  const text = String(value).toLowerCase();
  return (
    text.includes("toomanyrequests") ||
    text.includes("monthly limit has been exceeded") ||
    text.includes("quota has been reached")
  );
}

function setProviderKeys(config: AppConfig, provider: Provider, keys: ApiKeyEntry[]): AppConfig {
  return provider === "Compresto"
    ? { ...config, comprestoKeys: keys }
    : { ...config, tinifyKeys: keys };
}

function setActiveKeyId(config: AppConfig, provider: Provider, id: string | null): AppConfig {
  const selectedEntry = providerKeys(config, provider).find((entry) => entry.id === id);
  const selectedKey = selectedEntry?.key ?? "";
  if (provider === "Compresto") {
    return {
      ...config,
      activeComprestoKeyId: id,
      comprestoApiKey: selectedKey,
    };
  }
  return {
    ...config,
    activeTinifyKeyId: id,
    tinifyApiKey: selectedKey,
    tinifyCompressionCount: selectedEntry?.used ?? null,
    tinifyLastCheckedAt: selectedEntry?.lastCheckedAt ?? null,
  };
}

function applyUsageToConfig(
  config: AppConfig,
  provider: Provider,
  usage: UsageResult,
  keyId: string | null = activeKeyId(config, provider),
): AppConfig {
  const keys = providerKeys(config, provider).map((entry) =>
    entry.id === keyId
      ? {
          ...entry,
          used: usage.used ?? null,
          limit: usage.limit ?? null,
          remaining: usage.remaining ?? null,
          lastCheckedAt: usage.lastCheckedAt,
          quotaExhausted: false,
        }
      : entry,
  );
  const next = setProviderKeys(config, provider, keys);
  if (provider === "Tinify") {
    return {
      ...next,
      tinifyCompressionCount: usage.used ?? null,
      tinifyLastCheckedAt: usage.lastCheckedAt,
    };
  }
  return next;
}

function usageFromConfig(config: AppConfig): Record<Provider, UsageResult | null> {
  return {
    Compresto: usageFromActiveKey("Compresto", config),
    Tinify: usageFromActiveKey("Tinify", config),
  };
}

function usageFromActiveKey(provider: Provider, config: AppConfig): UsageResult | null {
  const entry = providerKeys(config, provider).find((key) => key.id === activeKeyId(config, provider));
  if (!entry || entry.used == null) return null;
  return {
    provider,
    status: "ok",
    used: entry.used,
    limit: entry.limit ?? null,
    remaining: entry.remaining ?? null,
    lastCheckedAt: entry.lastCheckedAt ?? new Date().toISOString(),
    message: "Loaded from saved API key usage",
  };
}

function watchFoldersFromConfig(config: AppConfig): WatchFolderConfig[] {
  if (config.watchFolders?.length) return config.watchFolders;
  if (!config.watchFolderPath) return [];
  return [
    {
      id: `watch-${config.watchFolderPath}`,
      path: config.watchFolderPath,
      enabled: config.watchFolderEnabled,
      lastScannedAt: null,
      lastError: null,
    },
  ];
}

function enabledWatchFolders(config: AppConfig): WatchFolderConfig[] {
  return watchFoldersFromConfig(config).filter((folder) => folder.enabled);
}

function isItemInEnabledWatchFolders(item: QueueItem, config: AppConfig): boolean {
  return enabledWatchFolders(config).some((folder) => isPathInFolder(item.path, folder.path));
}

function configWithWatchFolders(config: AppConfig, folders: WatchFolderConfig[]): AppConfig {
  const firstFolder = folders[0] ?? null;
  return {
    ...config,
    watchFolders: folders,
    watchFolderPath: firstFolder?.path ?? null,
    watchFolderEnabled: folders.some((folder) => folder.enabled),
  };
}

function createWatchFolder(path: string): WatchFolderConfig {
  return {
    id: `watch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    path,
    enabled: true,
    lastScannedAt: null,
    lastError: null,
  };
}

function buildWatchFolderSummaries(
  config: AppConfig,
  scans: Record<string, WatchFolderScan & { lastScannedAt: string; lastError?: string | null }>,
  queue: QueueItem[],
): WatchFolderSummary[] {
  return watchFoldersFromConfig(config).map((folder) => {
    const scan = scans[folder.path];
    const folderQueue = queue.filter((item) => isPathInFolder(item.path, folder.path));
    const queueByPath = new Map(folderQueue.map((item) => [item.path, item]));
    const scannedFiles = scan?.files ?? [];
    const compressedFiles =
      scannedFiles.length > 0
        ? scannedFiles.filter((file) => {
            const queued = queueByPath.get(file.path);
            return file.isCompressed || queued?.isCompressed || queued?.status === "done";
          }).length
        : folderQueue.filter((item) => item.isCompressed || item.status === "done").length;
    const supportedFiles = scan?.supportedFiles ?? folderQueue.length;
    return {
      ...folder,
      allFiles: scan?.allFiles ?? 0,
      supportedFiles,
      compressedFiles,
      uncompressedFiles: Math.max(0, supportedFiles - compressedFiles),
      processingFiles: folderQueue.filter((item) => item.status === "processing").length,
      failedFiles: folderQueue.filter((item) => item.status === "failed").length,
      queuedFiles: folderQueue.filter((item) => item.status === "queued").length,
      lastScannedAt: scan?.lastScannedAt ?? folder.lastScannedAt ?? null,
      lastError: scan?.lastError ?? folder.lastError ?? null,
    };
  });
}

function isPathInFolder(path: string, folder: string): boolean {
  const normalizedFolder = normalizePathForCompare(folder).replace(/\/+$/, "");
  const normalizedPath = normalizePathForCompare(path);
  return normalizedPath.startsWith(`${normalizedFolder}/`);
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function folderName(path: string): string {
  const normalized = normalizePathForCompare(path);
  return normalized.split("/").filter(Boolean).pop() || normalized || "Folder";
}

function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function isMaskedSecret(value: string): boolean {
  return value.includes("•");
}

export default App;
