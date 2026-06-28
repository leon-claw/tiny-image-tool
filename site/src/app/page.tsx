import { download, featureBands, hero, metrics, mockup, providers, siteNav, workflow } from "../content.mdx";
import { HomePage } from "../components/HomePage";

export default function Page() {
  return (
    <HomePage
      download={download}
      featureBands={featureBands}
      hero={hero}
      metrics={metrics}
      mockup={mockup}
      providers={providers}
      siteNav={siteNav}
      workflow={workflow}
    />
  );
}
