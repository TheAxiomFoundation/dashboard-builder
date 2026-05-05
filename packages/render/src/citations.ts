/**
 * Citation helpers for render-side use. Mirrors the logic in
 * apps/builder/src/citations.ts and compute/engine.py so legal IDs render
 * the same way wherever the user encounters them.
 */

const JURISDICTION_LABELS: Record<string, string> = {
  us: "Federal",
  "us-co": "Colorado",
  "us-ca": "California",
  "us-ny": "New York",
};

const KIND_SINGULAR: Record<string, string> = {
  regulations: "regulation",
  statutes: "statute",
  policies: "policy",
  guidance: "guidance",
  bills: "bill",
};

export function humanizeCitation(fileLegalId: string): string {
  if (!fileLegalId.includes(":")) return fileLegalId;
  const [jurisdiction, body] = fileLegalId.split(":") as [string, string];
  const parts = body.split("/").filter(Boolean);
  if (parts.length === 0) return fileLegalId;
  const [kind, ...rest] = parts;

  if (kind === "statutes" && rest.length >= 2) {
    const title = rest[0];
    const section = rest[1];
    const subs = rest.slice(2);
    const suffix = subs.map((s) => `(${s})`).join("");
    return `${title} USC § ${section}${suffix}`;
  }

  if (kind === "regulations" && rest.length >= 2) {
    const slug = rest[0]!;
    const path = rest.slice(1).join(".");
    if (slug.toLowerCase() === "7-cfr") return `7 CFR § ${path}`;
    const readable = slug.replace(/-/g, " ").toUpperCase();
    const suffix = jurisdiction === "us-co" ? " (Colorado)" : "";
    return `${readable} § ${path}${suffix}`;
  }

  return `${JURISDICTION_LABELS[jurisdiction] ?? jurisdiction} · ${body}`;
}

export function axiomAppUrl(fileLegalId: string): string | null {
  if (!fileLegalId || !fileLegalId.includes(":")) return null;
  const [jurisdiction, body] = fileLegalId.split(":") as [string, string];
  const parts = body.split("/").filter(Boolean);
  if (parts.length < 1) return null;
  const [kind, ...rest] = parts;
  const singular = KIND_SINGULAR[kind!] ?? kind!;
  const path = [jurisdiction, singular, ...rest].join("/");
  return `https://app.axiom-foundation.org/${path}`;
}

/** A legalId for a rule or input is `<file>#rule.<name>` / `<file>#input.<name>`.
 *  Split off the `#…` suffix to recover the file legalId for citation/url. */
export function fileLegalIdOf(legalId: string): string {
  const hashIdx = legalId.indexOf("#");
  return hashIdx >= 0 ? legalId.slice(0, hashIdx) : legalId;
}
