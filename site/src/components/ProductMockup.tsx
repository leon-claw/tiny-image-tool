type ProductMockupContent = {
  brand: string;
  railItems: string[];
  toolbarTitle: string;
  toolbarBody: string;
  actions: string[];
  metrics: Array<{ label: string; value: string; detail: string }>;
  files: Array<{ name: string; path: string; before: string; after: string; status: string }>;
  settingsTitle: string;
  settings: string[];
};

type ProductMockupProps = {
  content: ProductMockupContent;
};

export function ProductMockup({ content }: ProductMockupProps) {
  return (
    <div className="product-mockup" aria-label="Tiny Image Tool app preview">
      <div className="mockup-window-bar">
        <span />
        <span />
        <span />
      </div>
      <div className="mockup-shell">
        <aside className="mockup-rail">
          <div className="mockup-brand">
            <span className="brand-mark" />
            <strong>{content.brand}</strong>
          </div>
          <nav>
            {content.railItems.map((item, index) => (
              <span className={index === 0 ? "active" : ""} key={item}>
                {item}
              </span>
            ))}
          </nav>
        </aside>

        <section className="mockup-main">
          <header className="mockup-toolbar">
            <div>
              <h2>{content.toolbarTitle}</h2>
              <p>{content.toolbarBody}</p>
            </div>
            <div className="mockup-actions">
              {content.actions.map((action, index) => (
                <span className={index === content.actions.length - 1 ? "primary" : ""} key={action}>
                  {action}
                </span>
              ))}
            </div>
          </header>

          <div className="mockup-metrics">
            {content.metrics.map((metric) => (
              <div className="mockup-metric" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </div>
            ))}
          </div>

          <div className="mockup-table">
            <div className="mockup-table-head">
              <span>文件</span>
              <span>原始</span>
              <span>输出</span>
              <span>状态</span>
            </div>
            {content.files.map((file) => (
              <div className="mockup-row" key={file.name}>
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                </span>
                <b>{file.before}</b>
                <b>{file.after}</b>
                <em className={`status-${file.status}`}>{file.status}</em>
              </div>
            ))}
          </div>
        </section>

        <aside className="mockup-settings">
          <h3>{content.settingsTitle}</h3>
          {content.settings.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </aside>
      </div>
    </div>
  );
}
