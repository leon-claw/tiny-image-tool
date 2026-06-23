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
  OutputPolicy,
  Provider,
  QueueItem,
  UsageResult,
  WatchFolderConfig,
  WatchFolderScan,
  WatchFolderSummary,
} from "./types";
import appIcon from "./assets/app-icon.png";
import {
  formatBytes,
  formatDateTime,
  prioritizeQueueByStatus,
  toQueueItems,
  totalBytes,
  type StatusFilter,
} from "./utils";

const defaultConfig: AppConfig = {
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
};

const defaultOptions: CompressOptions = {
  quality: 80,
  format: "same",
  maxWidth: null,
  maxHeight: null,
  preserveMetadata: false,
  preserveComfyWorkflow: true,
};

const MAX_PARALLEL_COMPRESSIONS = 5;
const WATCH_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const WATCH_NEW_FILE_DEBOUNCE_MS = 1600;

type ToastTone = "info" | "success" | "warning" | "error";
type WatchScanReason = "focus" | "timer" | "new-file" | "manual" | "enabled";
type AppView = "workbench" | "watch-folders";

type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};

function App() {
  const [activeProvider, setActiveProvider] = useState<Provider>("Compresto");
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
  const [notice, setNotice] = useState("选择文件或文件夹后开始压缩。已写入埋点的图片会自动跳过。");
  const [toast, setToast] = useState<ToastMessage | null>(null);
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
  const activeProviderRef = useRef<Provider>("Compresto");
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
    () => (activeWatchFolder ? queue.filter((item) => isPathInFolder(item.path, activeWatchFolder.path)) : queue),
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
    message = "API Key 已保存到本地配置。",
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
      const files = await invoke<QueueItem[]>("scan_paths", { paths });
      updateQueue((current) => [...current, ...toQueueItems(files, current)]);
      setNotice(`已加载 ${files.length} 个支持的图片文件。`);
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
      showToast("这些文件夹已经在监听列表中。", "warning");
      return;
    }

    const nextFolders = [...current, ...additions];
    persistWatchFolders(nextFolders, `已添加 ${additions.length} 个监听文件夹。`);
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
    persistWatchFolders(folders, enabled ? "监听文件夹已启用。" : "监听文件夹已暂停。");
    stopWatchRunIfNoEnabledFolders(folders);
  }

  function removeWatchFolder(id: string) {
    const folder = watchFoldersFromConfig(configRef.current).find((candidate) => candidate.id === id);
    const folders = watchFoldersFromConfig(configRef.current).filter((candidate) => candidate.id !== id);
    persistWatchFolders(folders, "监听文件夹已移除。");
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
      enabled ? "压缩时保持设备唤醒已开启。" : "压缩时保持设备唤醒已关闭。",
    );
  }

  async function refreshUsage(target: Provider = activeProvider) {
    const targetKeyId = activeKeyId(config, target);
    if (!hasUsableApiKey(config, target)) {
      showToast(`请先添加并选择 ${target} API Key，再刷新使用量。`, "warning");
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
      showToast(`${target} 使用量已刷新。`, "success");
    } catch (error) {
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
    const allFolders = enabledWatchFolders(currentConfig);
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
          const newItems = toQueueItems(scan.files, queueRef.current);
          totalNewItems += newItems.length;
          if (newItems.length) {
            updateQueue((current) => [...current, ...toQueueItems(scan.files, current)]);
          }
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
          showToast(`${folderName(folder.path)} 扫描失败：${String(error)}`, "error");
        }
      }
      if (reason === "manual") {
        showToast(totalNewItems ? `发现 ${totalNewItems} 个新图片。` : "监听文件夹没有新图片。", "info");
      }
      setNotice(`监听文件夹已扫描：${folders.length} 个目录，${totalFiles} 个当前层级图片。`);

      const runnable = runnableItems(queueRef.current).filter((item) => runnablePaths.has(item.path));
      if (!runnable.length) return;
      if (outputPolicyRef.current === "Overwrite") {
        showToast("监听自动压缩不会执行覆盖源文件。请改为 compressed/ 或自定义输出目录。", "warning");
        return;
      }
      const provider = activeProviderRef.current;
      if (!hasUsableApiKey(configRef.current, provider)) {
        showToast(`监听发现新图片，但 ${provider} API Key 不可用。`, "warning");
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
    const runnable = runnableItems(activeWatchFolder ? queueRef.current.filter((item) => isPathInFolder(item.path, activeWatchFolder.path)) : queueRef.current);
    if (!runnable.length) {
      showToast(queueRef.current.length ? "当前没有可压缩的图片。已压缩文件会被自动跳过。" : "请先选择文件或文件夹。", "warning");
      return;
    }
    if (!hasUsableApiKey(config, activeProvider)) {
      showToast(`请先添加并选择 ${activeProvider} API Key，再开始压缩。`, "warning");
      return;
    }
    if (outputPolicy === "CustomDirectory" && !customOutputDir) {
      showToast("请先选择输出目录。", "warning");
      return;
    }
    if (outputPolicy === "Overwrite" && !window.confirm("覆盖模式会直接替换源文件，是否继续？")) {
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
      `${source === "watch" ? "监听任务" : "手动任务"}正在处理 ${runnable.length} 个文件，最多 ${MAX_PARALLEL_COMPRESSIONS} 个并行。每张图片会使用派发时选中的 API Key。`,
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
                ? { ...candidate, status: "failed", error: `${itemProvider} API Key 不可用，请重新选择。` }
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
                candidate.id === item.id ? { ...candidate, status: "cancelled", error: "已停止" } : candidate,
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
          updateQueue((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? stopRequestedRef.current
                  ? { ...candidate, status: "cancelled", error: "已停止" }
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
        ? "已停止。正在压缩的结果已丢弃。"
        : pauseRef.current
          ? "已暂停。再次开始会继续处理未完成文件。"
          : "处理完成。",
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
      showToast(`保持设备唤醒未能开启：${String(error)}`, "warning");
      return false;
    }
  }

  async function endKeepAwakeIfNeeded(started: boolean) {
    if (!started) return;
    try {
      await invoke("end_power_assertion");
    } catch (error) {
      showToast(`保持设备唤醒未能释放：${String(error)}`, "warning");
    }
  }

  function requestPause() {
    pauseRef.current = true;
    setIsPauseRequested(true);
    setNotice("暂停请求已收到，当前文件完成后会停止。");
  }

  function requestImmediateStop() {
    if (!isRunningRef.current) return;
    stopRequestedRef.current = true;
    pauseRef.current = true;
    autoRunAfterCurrentBatchRef.current = false;
    setIsPauseRequested(true);
    setNotice("正在立即停止，当前压缩结果会被丢弃。");
    updateQueue((current) =>
      current.map((item) =>
        item.status === "processing" ? { ...item, status: "cancelled", error: "已停止" } : item,
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
      setNotice("监听已暂停，当前正在上传的图片完成后会停止。");
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
    return (
      <aside className="settings-pane">
        <div className="tabs">
          <button
            type="button"
            className={activeProvider === "Compresto" ? "active" : ""}
            onClick={() => selectProvider("Compresto")}
          >
            Compresto
          </button>
          <button
            type="button"
            className={activeProvider === "Tinify" ? "active" : ""}
            onClick={() => selectProvider("Tinify")}
          >
            Tinify
          </button>
        </div>

        {activeProvider === "Compresto" ? (
          <ComprestoSettings
            config={config}
            persistKeyChange={persistKeyChange}
            notify={showToast}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            toggleKeepAwake={toggleKeepAwake}
            usage={usage.Compresto}
            refreshUsage={() => refreshUsage("Compresto")}
            loading={isRefreshingUsage}
          />
        ) : (
          <TinifySettings
            config={config}
            persistKeyChange={persistKeyChange}
            notify={showToast}
            options={options}
            setOptions={setOptions}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            toggleKeepAwake={toggleKeepAwake}
            usage={usage.Tinify}
            refreshUsage={() => refreshUsage("Tinify")}
            loading={isRefreshingUsage}
          />
        )}

        {showRunBar ? (
          <footer className="run-bar">
            <button type="button" className="primary" onClick={startCompression} disabled={isRunning}>
              {isRunning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              开始
            </button>
            <button type="button" onClick={requestPause} disabled={!isRunning || isPauseRequested}>
              <Pause size={18} />
              {isPauseRequested ? "暂停中" : "暂停"}
            </button>
            <button type="button" className="danger" onClick={requestImmediateStop} disabled={!isRunning}>
              <Square size={17} />
              立即停止
            </button>
          </footer>
        ) : null}
      </aside>
    );
  }

  if (view === "watch-folders") {
    return (
      <>
        <WatchFoldersPage
          summaries={watchFolderSummaries}
          isScanning={isWatchScanning}
          addFolders={chooseWatchFolders}
          scanAll={() => scanWatchedFolders("manual")}
          openFolder={openWatchFolderDetail}
          toggleFolder={toggleWatchFolder}
          removeFolder={removeWatchFolder}
          setAllEnabled={(enabled) => {
            const folders = watchFoldersFromConfig(configRef.current).map((folder) => ({ ...folder, enabled }));
            persistWatchFolders(folders, enabled ? "全部监听文件夹已启用。" : "全部监听文件夹已暂停。");
            stopWatchRunIfNoEnabledFolders(folders);
          }}
          backToWorkbench={() => {
            setActiveWatchFolderId(null);
            setView("workbench");
          }}
          settingsPane={renderSettingsPane(false)}
        />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  return (
    <>
      <main className="app-shell" data-provider={activeProvider.toLowerCase()}>
      <section className="file-pane">
        <header className="file-toolbar">
          <div className="brand-lockup">
            <div className="brand-sigil">
              <img src={appIcon} alt="" />
            </div>
            <div>
              <h1>Tiny Image Tool</h1>
              {activeWatchFolder ? (
                <div className="breadcrumb" aria-label="当前位置">
                  <button type="button" onClick={() => setView("watch-folders")}>
                    监听文件夹
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
            <button type="button" onClick={() => setView("watch-folders")}>
              <ListTree size={17} />
              监听文件夹
            </button>
            <button type="button" onClick={chooseFiles}>
              <FileImage size={17} />
              选择文件
            </button>
            <button type="button" onClick={chooseFolder}>
              <FolderOpen size={17} />
              选择文件夹
            </button>
            <button type="button" className="ghost" onClick={removeSelected} disabled={!stats.selected || isRunning}>
              <Trash2 size={17} />
              批量删除
            </button>
          </div>
        </header>

        <section className="summary-strip">
          <Metric label="文件" value={String(visibleQueue.length)} detail={`${stats.selected} 已选`} />
          <Metric label="已压缩" value={String(stats.already)} detail="埋点命中" />
          <Metric label="完成" value={String(stats.done)} detail={`${stats.failed} failed`} />
          <Metric label="原始大小" value={formatBytes(stats.original)} detail={formatBytes(stats.compressed)} />
        </section>

        <section className="explorer">
          <div className="explorer-head">
            <label className="select-all">
              <input
                type="checkbox"
                checked={visibleQueue.length > 0 && stats.selected === visibleQueue.length}
                onChange={toggleAllSelected}
              />
              资产
            </label>
            <label className="status-filter">
              状态
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="default">默认</option>
                <option value="queued">待处理</option>
                <option value="processing">处理中</option>
                <option value="failed">失败</option>
                <option value="done">已压缩</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
            <span>大小</span>
            <span>操作</span>
          </div>
          <div className="explorer-body">
            {queue.length === 0 ? (
              <div className="empty-state">
                <FileImage size={30} />
                <span>未加载图片</span>
              </div>
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
                  <StatusBadge item={item} />
                  <span className="size-cell">
                    {formatBytes(item.size)}
                    {item.compressedSize ? <small>{formatBytes(item.compressedSize)}</small> : null}
                  </span>
                  <button className="icon" type="button" title="删除" onClick={() => removeOne(item.id)} disabled={isRunning}>
                    <Trash2 size={16} />
                  </button>
                  {item.error ? <p className="row-error">{item.error}</p> : null}
                </div>
              ))
            )}
          </div>
        </section>
      </section>

      {renderSettingsPane(true)}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

function WatchFoldersPage({
  summaries,
  isScanning,
  addFolders,
  scanAll,
  openFolder,
  toggleFolder,
  removeFolder,
  setAllEnabled,
  backToWorkbench,
  settingsPane,
}: {
  summaries: WatchFolderSummary[];
  isScanning: boolean;
  addFolders: () => void;
  scanAll: () => void;
  openFolder: (id: string) => void;
  toggleFolder: (id: string, enabled: boolean) => void;
  removeFolder: (id: string) => void;
  setAllEnabled: (enabled: boolean) => void;
  backToWorkbench: () => void;
  settingsPane: React.ReactNode;
}) {
  const totalPending = summaries.reduce((sum, folder) => sum + folder.uncompressedFiles, 0);
  const totalProcessing = summaries.reduce((sum, folder) => sum + folder.processingFiles, 0);
  const totalFailed = summaries.reduce((sum, folder) => sum + folder.failedFiles, 0);
  const totalSupported = summaries.reduce((sum, folder) => sum + folder.supportedFiles, 0);
  const totalCompressed = summaries.reduce((sum, folder) => sum + folder.compressedFiles, 0);
  const totalFiles = summaries.reduce((sum, folder) => sum + folder.allFiles, 0);
  const enabledCount = summaries.filter((folder) => folder.enabled).length;

  return (
    <main className="watch-shell">
      <section className="watch-page">
        <header className="watch-page-header">
          <div className="brand-lockup">
            <div className="brand-sigil">
              <img src={appIcon} alt="" />
            </div>
            <div>
              <h1>监听文件夹</h1>
              <p>自动扫描当前层级图片，使用右侧当前服务商和 API Key。</p>
            </div>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={backToWorkbench}>
              返回工作台
            </button>
            <button type="button" onClick={addFolders}>
              <FolderOpen size={17} />
              添加文件夹
            </button>
            <button type="button" className="refresh-button" onClick={scanAll} disabled={!enabledCount || isScanning}>
              {isScanning ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
              扫描全部
            </button>
            <button type="button" className="ghost" onClick={() => setAllEnabled(enabledCount !== summaries.length)}>
              {enabledCount === summaries.length && summaries.length ? "暂停全部" : "恢复全部"}
            </button>
          </div>
        </header>

        <section className="watch-summary-grid">
          <Metric label="监听中" value={String(enabledCount)} detail={`${summaries.length} folders`} />
          <Metric label="待压缩" value={String(totalPending)} detail="未压缩图片" />
          <Metric label="正在压缩" value={String(totalProcessing)} detail="全局并行队列" />
          <Metric label="失败" value={String(totalFailed)} detail="最近任务" />
        </section>

        <details className="watch-extra-stats">
          <summary>
            更多统计：所有文件 {totalFiles} · 支持格式 {totalSupported} · 已压缩 {totalCompressed} · 文件夹 {summaries.length}
          </summary>
          <div className="watch-summary-grid compact">
            <Metric label="文件夹" value={String(summaries.length)} detail={`${enabledCount} enabled`} />
            <Metric label="所有文件" value={String(totalFiles)} detail="当前层级" />
            <Metric label="支持格式" value={String(totalSupported)} detail="jpg/png/webp" />
            <Metric label="已压缩" value={String(totalCompressed)} detail="埋点或输出命中" />
          </div>
        </details>

        <section className="watch-table">
          <div className="watch-table-scroll">
            <div className="watch-table-head">
              <span>文件夹</span>
              <span>状态</span>
              <span>所有</span>
              <span>未压缩</span>
              <span>已压缩</span>
              <span>处理中</span>
              <span>失败</span>
              <span className="watch-sticky-col">操作</span>
            </div>
            {summaries.length === 0 ? (
              <div className="empty-state">
                <FolderOpen size={30} />
                <span>还没有监听文件夹</span>
                <button type="button" onClick={addFolders}>
                  <Plus size={16} />
                  添加文件夹
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
                        最近扫描：{folder.lastScannedAt ? formatDateTime(folder.lastScannedAt) : "Never"}
                        {folder.lastError ? ` · ${folder.lastError}` : ""}
                      </small>
                    </span>
                  </button>
                  <span className={folder.enabled ? "watch-state active" : "watch-state"}>
                    {folder.enabled ? "监听中" : "已暂停"}
                  </span>
                  <b>{folder.allFiles}</b>
                  <b>{folder.uncompressedFiles}</b>
                  <b>{folder.compressedFiles}</b>
                  <b>{folder.processingFiles}</b>
                  <b>{folder.failedFiles}</b>
                  <div className="watch-row-actions watch-sticky-col">
                    <button className="icon" type="button" title="进入" onClick={() => openFolder(folder.id)}>
                      <ChevronRight size={16} />
                    </button>
                    <button className="icon" type="button" title={folder.enabled ? "暂停" : "恢复"} onClick={() => toggleFolder(folder.id, !folder.enabled)}>
                      {folder.enabled ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <button className="icon" type="button" title="移除" onClick={() => removeFolder(folder.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </section>
      {settingsPane}
    </main>
  );
}

function ComprestoSettings({
  config,
  persistKeyChange,
  notify,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  toggleKeepAwake,
  usage,
  refreshUsage,
  loading,
}: SettingsProps) {
  return (
    <div className="settings-content">
      <Panel title="API Key" icon={<KeyRound size={18} />}>
        <ApiKeyManager provider="Compresto" config={config} persistKeyChange={persistKeyChange} notify={notify} />
      </Panel>
      <OutputPanel {...{ config, outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir, toggleKeepAwake }} />
      <UsagePanel provider="Compresto" result={usage} onRefresh={refreshUsage} loading={loading} />
    </div>
  );
}

function TinifySettings({
  config,
  persistKeyChange,
  notify,
  options,
  setOptions,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  toggleKeepAwake,
  usage,
  refreshUsage,
  loading,
}: SettingsProps & {
  options: CompressOptions;
  setOptions: (options: CompressOptions) => void;
}) {
  return (
    <div className="settings-content">
      <Panel title="API Key" icon={<KeyRound size={18} />}>
        <ApiKeyManager provider="Tinify" config={config} persistKeyChange={persistKeyChange} notify={notify} />
      </Panel>

      <Panel title="Tinify 参数" icon={<Layers3 size={18} />}>
        <label>
          输出格式
          <select value={options.format} onChange={(event) => setOptions({ ...options, format: event.target.value })}>
            <option value="same">保持原格式</option>
            <option value="jpg">JPG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
          </select>
        </label>
        <div className="split">
          <label>
            最大宽度
            <input
              type="number"
              min="1"
              placeholder="自动"
              value={options.maxWidth ?? ""}
              onChange={(event) => setOptions({ ...options, maxWidth: optionalNumber(event.target.value) })}
            />
          </label>
          <label>
            最大高度
            <input
              type="number"
              min="1"
              placeholder="自动"
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
          保留 Tinify 支持的 metadata
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={options.preserveComfyWorkflow}
            onChange={(event) => setOptions({ ...options, preserveComfyWorkflow: event.target.checked })}
          />
          保留 ComfyUI workflow 配置
        </label>
      </Panel>

      <OutputPanel {...{ config, outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir, toggleKeepAwake }} />
      <UsagePanel provider="Tinify" result={usage} onRefresh={refreshUsage} loading={loading} />
    </div>
  );
}

type SettingsProps = {
  config: AppConfig;
  persistKeyChange: (config: AppConfig, message: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
  toggleKeepAwake: (enabled: boolean) => void;
  usage: UsageResult | null;
  refreshUsage: () => void;
  loading: boolean;
};

function ApiKeyManager({
  provider,
  config,
  persistKeyChange,
  notify,
}: {
  provider: Provider;
  config: AppConfig;
  persistKeyChange: (config: AppConfig, message: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
}) {
  const [draftKey, setDraftKey] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const keys = providerKeys(config, provider);
  const activeId = activeKeyId(config, provider);

  function addKey() {
    const key = draftKey.trim();
    if (!key) return;
    if (hasDuplicateKey(keys, key)) {
      notify(`${provider} API Key 已存在，请勿重复添加。`, "error");
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
    };
    persistKeyChange(
      setProviderKeys(
        setActiveKeyId(config, provider, entry.id),
        provider,
        [...keys, entry],
      ),
      `${provider} API Key 已添加。`,
    );
    setDraftKey("");
  }

  function activateKey(id: string) {
    persistKeyChange(setActiveKeyId(config, provider, id), `${provider} 已切换当前 API Key。`);
  }

  function removeKey(entry: ApiKeyEntry) {
    const nextKeys = keys.filter((key) => key.id !== entry.id);
    const nextConfig = setProviderKeys(config, provider, nextKeys);
    persistKeyChange(
      setActiveKeyId(nextConfig, provider, nextKeys[0]?.id ?? null),
      `${provider} API Key 已删除。`,
    );
    setPendingDelete(null);
  }

  return (
    <>
      <div className="key-manager">
        <div className="key-list">
          {keys.length === 0 ? (
            <div className="key-empty">无 API Key</div>
          ) : (
            keys.map((entry, index) => (
              <div className={entry.id === activeId ? "key-row active" : "key-row"} key={entry.id}>
                <button type="button" className="key-main" onClick={() => activateKey(entry.id)}>
                  <CircleDot size={14} />
                  <span>
                    <strong>{entry.label || `Key ${index + 1}`}</strong>
                    <small>{entry.lastCheckedAt ? formatDateTime(entry.lastCheckedAt) : "No usage yet"}</small>
                  </span>
                  <b>{formatKeyUsage(entry)}</b>
                </button>
                <button className="icon" type="button" title="删除 API Key" onClick={() => setPendingDelete(entry)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}
        </div>
        <label>
          添加新的 API Key
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
          添加并保存
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="删除 API Key"
        message={`确认删除 ${provider} API Key ${pendingDelete?.label ?? ""}？删除后需要重新添加才能继续使用。`}
        confirmText="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) removeKey(pendingDelete);
        }}
      />
    </>
  );
}

function OutputPanel({
  config,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  toggleKeepAwake,
}: {
  config: AppConfig;
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
  toggleKeepAwake: (enabled: boolean) => void;
}) {
  return (
    <Panel title="输出" icon={<FolderOpen size={18} />}>
      <select value={outputPolicy} onChange={(event) => setOutputPolicy(event.target.value as OutputPolicy)}>
        <option value="Subdirectory">源文件旁 compressed 文件夹</option>
        <option value="CustomDirectory">自定义输出目录</option>
        <option value="Overwrite">覆盖源文件</option>
      </select>
      <button className="ghost" type="button" onClick={chooseOutputDir}>
        <FolderOpen size={16} />
        选择输出目录
      </button>
      <p className="hint">{outputPolicy === "CustomDirectory" ? customOutputDir || "尚未选择目录" : "compressed/"}</p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={config.keepAwakeDuringCompression}
          onChange={(event) => toggleKeepAwake(event.target.checked)}
        />
        压缩时保持设备唤醒
      </label>
    </Panel>
  );
}

function UsagePanel({
  provider,
  result,
  onRefresh,
  loading,
}: {
  provider: Provider;
  result: UsageResult | null;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <Panel title="API 使用量" icon={<Gauge size={18} />}>
      <div className="usage-card">
        <strong>{provider}</strong>
        <dl>
          <dt>Used</dt>
          <dd>{result?.used ?? "—"}</dd>
          <dt>Limit</dt>
          <dd>{result?.limit ?? "—"}</dd>
          <dt>Remaining</dt>
          <dd>{result?.remaining ?? "—"}</dd>
        </dl>
        <p>{result ? `${formatDateTime(result.lastCheckedAt)} · ${result.message}` : "尚未刷新"}</p>
      </div>
      <button type="button" className="refresh-button" onClick={onRefresh} disabled={loading}>
        {loading ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
        刷新
      </button>
    </Panel>
  );
}

function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  if (!toast) return null;

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      {toast.tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <p>{toast.message}</p>
      <button className="icon toast-close" type="button" title="关闭" onClick={onClose}>
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
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
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
            取消
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

function StatusBadge({ item }: { item: QueueItem }) {
  if (item.isCompressed || item.status === "done") {
    return (
      <span className="badge done">
        <CheckCircle2 size={14} />
        已压缩
      </span>
    );
  }
  if (item.status === "failed") {
    return (
      <span className="badge failed" title={item.error}>
        <AlertCircle size={14} />
        失败
      </span>
    );
  }
  if (item.status === "processing") {
    return (
      <span className="badge processing">
        <Loader2 className="spin" size={14} />
        处理中
      </span>
    );
  }
  return <span className="badge">待处理</span>;
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
  const activeValue = activeKey(config, provider)?.key.trim();
  const legacyValue = provider === "Compresto" ? config.comprestoApiKey.trim() : config.tinifyApiKey.trim();
  return Boolean(activeValue || (legacyValue && !isMaskedSecret(legacyValue)));
}

function hasDuplicateKey(keys: ApiKeyEntry[], value: string): boolean {
  const normalized = value.trim();
  const masked = maskKey(normalized);
  return keys.some((entry) => {
    const savedKey = entry.key.trim();
    return savedKey === normalized || savedKey === masked || entry.label === masked;
  });
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

function formatKeyUsage(entry: ApiKeyEntry): string {
  if (entry.used == null && entry.remaining == null) return "—";
  if (entry.remaining != null) return `${entry.used ?? "—"} / ${entry.remaining}`;
  return String(entry.used);
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
