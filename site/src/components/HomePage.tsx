import { ArrowRight, Download } from "lucide-react";
import { IconBadge } from "./IconBadge";
import { ProductMockup } from "./ProductMockup";

type NavContent = {
  brand: string;
  tagline: string;
  links: Array<{ label: string; href: string }>;
  cta: { label: string; href: string };
};

type HeroContent = {
  eyebrow: string;
  title: string;
  body: string;
  primaryCta: { label: string; href: string };
  secondaryCta: { label: string; href: string };
  note: string;
};

type Metric = {
  icon: string;
  label: string;
  value: string;
  detail: string;
};

type WorkflowContent = {
  eyebrow: string;
  title: string;
  body: string;
  steps: Array<{ icon: string; title: string; body: string }>;
};

type FeatureBand = {
  icon: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
};

type ProvidersContent = {
  eyebrow: string;
  title: string;
  body: string;
  cards: Array<{ icon: string; title: string; body: string }>;
};

type DownloadContent = {
  eyebrow: string;
  title: string;
  body: string;
  actions: Array<{ label: string; href: string }>;
  footnote: string;
};

type HomePageProps = {
  download: unknown;
  featureBands: unknown;
  hero: unknown;
  metrics: unknown;
  mockup: unknown;
  providers: unknown;
  siteNav: unknown;
  workflow: unknown;
};

export function HomePage(props: HomePageProps) {
  const siteNav = props.siteNav as NavContent;
  const hero = props.hero as HeroContent;
  const metrics = props.metrics as Metric[];
  const workflow = props.workflow as WorkflowContent;
  const featureBands = props.featureBands as FeatureBand[];
  const providers = props.providers as ProvidersContent;
  const download = props.download as DownloadContent;

  return (
    <main className="site-page">
      <header className="site-header">
        <a className="site-lockup" href="#top" aria-label={siteNav.brand}>
          <span className="brand-mark" />
          <span>
            <strong>{siteNav.brand}</strong>
            <small>{siteNav.tagline}</small>
          </span>
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          {siteNav.links.map((link) => (
            <a href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <a className="button button-dark header-cta" href={siteNav.cta.href}>
          <Download size={16} />
          {siteNav.cta.label}
        </a>
      </header>

      <section className="hero-section" id="top">
        <div className="hero-copy">
          <p className="eyebrow">{hero.eyebrow}</p>
          <h1>{hero.title}</h1>
          <p className="hero-body">{hero.body}</p>
          <div className="hero-actions">
            <a className="button button-dark" href={hero.primaryCta.href}>
              <Download size={17} />
              {hero.primaryCta.label}
            </a>
            <a className="button button-ghost" href={hero.secondaryCta.href}>
              {hero.secondaryCta.label}
              <ArrowRight size={17} />
            </a>
          </div>
          <p className="hero-note">{hero.note}</p>
        </div>
        <ProductMockup content={props.mockup as Parameters<typeof ProductMockup>[0]["content"]} />
      </section>

      <section className="metric-strip" id="features" aria-label="Key features">
        {metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <IconBadge icon={metric.icon} />
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
      </section>

      <section className="workflow-section" id="workflow">
        <div className="section-heading">
          <p className="eyebrow">{workflow.eyebrow}</p>
          <h2>{workflow.title}</h2>
          <p>{workflow.body}</p>
        </div>
        <div className="workflow-grid">
          {workflow.steps.map((step, index) => (
            <article className="workflow-card" key={step.title}>
              <div className="step-row">
                <IconBadge icon={step.icon} tone={index === 2 ? "dark" : "accent"} />
                <span>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="feature-bands" aria-label="Detailed features">
        {featureBands.map((band, index) => (
          <article className="feature-band" key={band.title}>
            <div>
              <IconBadge icon={band.icon} tone={index === 0 ? "blue" : "accent"} />
              <p className="eyebrow">{band.eyebrow}</p>
              <h2>{band.title}</h2>
              <p>{band.body}</p>
            </div>
            <ul>
              {band.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="providers-section" id="providers">
        <div className="section-heading">
          <p className="eyebrow">{providers.eyebrow}</p>
          <h2>{providers.title}</h2>
          <p>{providers.body}</p>
        </div>
        <div className="provider-grid">
          {providers.cards.map((card) => (
            <article className="provider-card" key={card.title}>
              <IconBadge icon={card.icon} />
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="download-section" id="download">
        <div>
          <p className="eyebrow">{download.eyebrow}</p>
          <h2>{download.title}</h2>
          <p>{download.body}</p>
          <small>{download.footnote}</small>
        </div>
        <div className="download-actions">
          {download.actions.map((action, index) => (
            <a className={index === 0 ? "button button-dark" : "button button-light"} href={action.href} key={action.label}>
              <Download size={17} />
              {action.label}
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
