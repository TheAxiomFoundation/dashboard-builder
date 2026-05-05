import yaml from "js-yaml";
import type { DashboardSpec } from "@dashboard-builder/spec";
import coSnapYaml from "../../../examples/co-snap.dashboard.yaml?raw";

const COMPUTE_URL =
  (import.meta.env.VITE_COMPUTE_URL as string | undefined) ?? "http://127.0.0.1:8787";

/**
 * Resolve which DashboardSpec to render. Priority:
 *   1. /d/{slug}            — fetches a published dashboard from compute
 *   2. ?spec=<url>          — fetches the YAML/JSON at the given URL
 *   3. localStorage         — written by the builder for preview-in-tab use
 *   4. Bundled CO SNAP      — always works for the demo
 */
export async function loadSpec(): Promise<{ spec: DashboardSpec; source: string; slug?: string }> {
  // 1. Published dashboard via slug.
  const slugMatch = window.location.pathname.match(/^\/d\/([^/]+)\/?$/);
  if (slugMatch && slugMatch[1]) {
    const slug = slugMatch[1];
    const res = await fetch(`${COMPUTE_URL}/dashboards/${encodeURIComponent(slug)}`);
    if (!res.ok) {
      throw new Error(
        `dashboard "${slug}" not found (${res.status}). It may have been deleted, or the compute service is down.`,
      );
    }
    const record = await res.json();
    return { spec: record.spec as DashboardSpec, source: `published / ${slug}`, slug };
  }

  // 2. Spec URL.
  const params = new URLSearchParams(window.location.search);
  const url = params.get("spec");
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch spec from ${url}: ${res.status}`);
    const text = await res.text();
    return { spec: yaml.load(text) as DashboardSpec, source: url };
  }

  // 3. Builder preview via localStorage.
  const stored = localStorage.getItem("dashboard-builder.spec");
  if (stored) {
    return { spec: JSON.parse(stored) as DashboardSpec, source: "localStorage (builder preview)" };
  }

  // 4. Bundled fallback.
  return {
    spec: yaml.load(coSnapYaml) as DashboardSpec,
    source: "bundled co-snap example",
  };
}
