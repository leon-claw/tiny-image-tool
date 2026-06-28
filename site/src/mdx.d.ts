declare module "*.mdx" {
  import type { ComponentType } from "react";

  const MDXComponent: ComponentType<Record<string, unknown>>;
  export default MDXComponent;

  export const siteNav: unknown;
  export const hero: unknown;
  export const metrics: unknown;
  export const workflow: unknown;
  export const featureBands: unknown;
  export const providers: unknown;
  export const download: unknown;
  export const mockup: unknown;
}
