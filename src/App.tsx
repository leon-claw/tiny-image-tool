import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  FileImage,
  FolderOpen,
  Gauge,
  KeyRound,
  Layers3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import type {
  AppConfig,
  ApiKeyEntry,
  CompressOptions,
  CompressResult,
  OutputPolicy,
  Provider,
  QueueItem,
  UsageResult,
} from "./types";
import { formatBytes, formatDateTime, toQueueItems, totalBytes } from "./utils";

const defaultConfig: AppConfig = {
  comprestoApiKey: "",
  tinifyApiKey: "",
  tinifyCompressionCount: null,
  tinifyLastCheckedAt: null,
  comprestoKeys: [],
  tinifyKeys: [],
  activeComprestoKeyId: null,
  activeTinifyKeyId: null,
};

const defaultOptions: CompressOptions = {
  quality: 80,
  format: "same",
  maxWidth: null,
  maxHeight: null,
  preserveMetadata: false,
  preserveComfyWorkflow: true,
};

type ToastTone = "info" | "success" | "warning" | "error";

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
  const [notice, setNotice] = useState("选择文件或文件夹后开始压缩。已写入埋点的图片会自动跳过。");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const pauseRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const configSaveRef = useRef<Promise<AppConfig | null>>(Promise.resolve(null));
  const configSaveVersionRef = useRef(0);
  const configRef = useRef<AppConfig>(defaultConfig);

  const stats = useMemo(() => {
    const original = totalBytes(queue, "size");
    const compressed = totalBytes(queue, "compressedSize");
    const done = queue.filter((item) => item.status === "done").length;
    const failed = queue.filter((item) => item.status === "failed").length;
    const already = queue.filter((item) => item.isCompressed).length;
    const selected = queue.filter((item) => item.selected).length;
    return { original, compressed, done, failed, already, selected };
  }, [queue]);

  useEffect(() => {
    void loadConfig();
    const unlisten = listen("tauri://drag-drop", (event) => {
      const payload = event.payload as { paths?: string[] };
      if (Array.isArray(payload.paths)) {
        void addPaths(payload.paths);
      }
    });

    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

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
      setQueue((current) => [...current, ...toQueueItems(files, current)]);
      setNotice(`已加载 ${files.length} 个支持的图片文件。`);
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif"] }],
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

  async function startCompression() {
    const runProvider = activeProvider;
    const runKeyId = activeKeyId(config, runProvider);
    const runnable = queue.filter(
      (item) => !item.isCompressed && (item.status === "queued" || item.status === "failed" || item.status === "cancelled"),
    );
    if (!runnable.length) {
      showToast(queue.length ? "当前没有可压缩的图片。已压缩文件会被自动跳过。" : "请先选择文件或文件夹。", "warning");
      return;
    }
    if (!hasUsableApiKey(config, runProvider)) {
      showToast(`请先添加并选择 ${runProvider} API Key，再开始压缩。`, "warning");
      return;
    }
    if (outputPolicy === "CustomDirectory" && !customOutputDir) {
      showToast("请先选择输出目录。", "warning");
      return;
    }
    if (outputPolicy === "Overwrite" && !window.confirm("覆盖模式会直接替换源文件，是否继续？")) {
      return;
    }

    pauseRef.current = false;
    setIsPauseRequested(false);
    setIsRunning(true);
    await configSaveRef.current;
    setNotice(`正在使用 ${runProvider} 处理 ${runnable.length} 个文件。`);

    for (const item of runnable) {
      if (pauseRef.current) {
        break;
      }

      setQueue((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, status: "processing", error: undefined } : candidate,
        ),
      );

      try {
        const result = await invoke<CompressResult>("compress_image", {
          path: item.path,
          provider: runProvider,
          keyId: runKeyId,
          options: normalizeOptions(options),
          outputPolicy,
          customOutputDir: customOutputDir || null,
        });

        setQueue((current) =>
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
            activeKeyId(configRef.current, result.provider) === runKeyId
              ? { ...current, [result.provider]: result.usage ?? null }
              : current,
          );
          setConfig((current) => applyUsageToConfig(current, result.provider, result.usage as UsageResult, runKeyId));
        }
        if (pauseRef.current) {
          break;
        }
      } catch (error) {
        setQueue((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, status: "failed", error: String(error) } : candidate,
          ),
        );
      }
    }

    setIsRunning(false);
    setIsPauseRequested(false);
    setNotice(pauseRef.current ? "已暂停。再次开始会继续处理未完成文件。" : "处理完成。");
  }

  function requestPause() {
    pauseRef.current = true;
    setIsPauseRequested(true);
    setNotice("暂停请求已收到，当前文件完成后会停止。");
  }

  function persistKeyChange(nextConfig: AppConfig, message: string) {
    setConfig(nextConfig);
    setUsage(usageFromConfig(nextConfig));
    const version = configSaveVersionRef.current + 1;
    configSaveVersionRef.current = version;
    configSaveRef.current = saveConfig(nextConfig, message, version);
    void configSaveRef.current;
  }

  function toggleSelected(id: string) {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item)),
    );
  }

  function toggleAllSelected() {
    const shouldSelect = stats.selected !== queue.length;
    setQueue((current) => current.map((item) => ({ ...item, selected: shouldSelect })));
  }

  function removeSelected() {
    setQueue((current) => current.filter((item) => !item.selected));
  }

  function removeOne(id: string) {
    setQueue((current) => current.filter((item) => item.id !== id));
  }

  return (
    <>
      <main className="app-shell" data-provider={activeProvider.toLowerCase()}>
      <section className="file-pane">
        <header className="file-toolbar">
          <div className="brand-lockup">
            <div className="brand-sigil">TI</div>
            <div>
              <h1>Tiny Image Tool</h1>
              <p>{notice}</p>
            </div>
          </div>
          <div className="toolbar-actions">
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
          <Metric label="文件" value={String(queue.length)} detail={`${stats.selected} 已选`} />
          <Metric label="已压缩" value={String(stats.already)} detail="埋点命中" />
          <Metric label="完成" value={String(stats.done)} detail={`${stats.failed} failed`} />
          <Metric label="原始大小" value={formatBytes(stats.original)} detail={formatBytes(stats.compressed)} />
        </section>

        <section className="explorer">
          <div className="explorer-head">
            <label className="select-all">
              <input
                type="checkbox"
                checked={queue.length > 0 && stats.selected === queue.length}
                onChange={toggleAllSelected}
              />
              资产
            </label>
            <span>状态</span>
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
              queue.map((item) => (
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

      <aside className="settings-pane">
        <div className="tabs">
          <button
            type="button"
            className={activeProvider === "Compresto" ? "active" : ""}
            onClick={() => setActiveProvider("Compresto")}
          >
            Compresto
          </button>
          <button
            type="button"
            className={activeProvider === "Tinify" ? "active" : ""}
            onClick={() => setActiveProvider("Tinify")}
          >
            Tinify
          </button>
        </div>

        {activeProvider === "Compresto" ? (
          <ComprestoSettings
            config={config}
            setConfig={setConfig}
            saveConfig={saveConfig}
            persistKeyChange={persistKeyChange}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            usage={usage.Compresto}
            refreshUsage={() => refreshUsage("Compresto")}
            loading={isRefreshingUsage}
          />
        ) : (
          <TinifySettings
            config={config}
            setConfig={setConfig}
            saveConfig={saveConfig}
            persistKeyChange={persistKeyChange}
            options={options}
            setOptions={setOptions}
            outputPolicy={outputPolicy}
            setOutputPolicy={setOutputPolicy}
            chooseOutputDir={chooseOutputDir}
            customOutputDir={customOutputDir}
            usage={usage.Tinify}
            refreshUsage={() => refreshUsage("Tinify")}
            loading={isRefreshingUsage}
          />
        )}

        <footer className="run-bar">
          <button type="button" className="primary" onClick={startCompression} disabled={isRunning}>
            {isRunning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            开始
          </button>
          <button type="button" onClick={requestPause} disabled={!isRunning || isPauseRequested}>
            <Pause size={18} />
            {isPauseRequested ? "暂停中" : "暂停"}
          </button>
        </footer>
      </aside>
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

function ComprestoSettings({
  config,
  persistKeyChange,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
  usage,
  refreshUsage,
  loading,
}: SettingsProps) {
  return (
    <div className="settings-content">
      <Panel title="API Key" icon={<KeyRound size={18} />}>
        <ApiKeyManager provider="Compresto" config={config} persistKeyChange={persistKeyChange} />
      </Panel>
      <OutputPanel {...{ outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir }} />
      <UsagePanel provider="Compresto" result={usage} onRefresh={refreshUsage} loading={loading} />
    </div>
  );
}

function TinifySettings({
  config,
  persistKeyChange,
  options,
  setOptions,
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
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
        <ApiKeyManager provider="Tinify" config={config} persistKeyChange={persistKeyChange} />
      </Panel>

      <Panel title="Tinify 参数" icon={<Layers3 size={18} />}>
        <label>
          输出格式
          <select value={options.format} onChange={(event) => setOptions({ ...options, format: event.target.value })}>
            <option value="same">保持原格式</option>
            <option value="jpg">JPG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
            <option value="avif">AVIF</option>
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

      <OutputPanel {...{ outputPolicy, setOutputPolicy, chooseOutputDir, customOutputDir }} />
      <UsagePanel provider="Tinify" result={usage} onRefresh={refreshUsage} loading={loading} />
    </div>
  );
}

type SettingsProps = {
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  saveConfig: () => void;
  persistKeyChange: (config: AppConfig, message: string) => void;
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
  usage: UsageResult | null;
  refreshUsage: () => void;
  loading: boolean;
};

function ApiKeyManager({
  provider,
  config,
  persistKeyChange,
}: {
  provider: Provider;
  config: AppConfig;
  persistKeyChange: (config: AppConfig, message: string) => void;
}) {
  const [draftKey, setDraftKey] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ApiKeyEntry | null>(null);
  const keys = providerKeys(config, provider);
  const activeId = activeKeyId(config, provider);

  function addKey() {
    const key = draftKey.trim();
    if (!key) return;
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
  outputPolicy,
  setOutputPolicy,
  chooseOutputDir,
  customOutputDir,
}: {
  outputPolicy: OutputPolicy;
  setOutputPolicy: (policy: OutputPolicy) => void;
  chooseOutputDir: () => void;
  customOutputDir: string;
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
