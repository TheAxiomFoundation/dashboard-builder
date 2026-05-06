/**
 * Humanize a RuleSpec file legal ID into a citation string. Mirrors the
 * server-side `_humanize_citation` in compute/engine.py so groupings and
 * tooltips read the same on both ends.
 */

const JURISDICTION_LABELS: Record<string, string> = {
  us: "Federal",
  "us-co": "Colorado",
  "us-ca": "California",
  "us-ny": "New York",
  "us-tx": "Texas",
  "us-fl": "Florida",
  "us-ga": "Georgia",
  "us-md": "Maryland",
  "us-nc": "North Carolina",
  "us-sc": "South Carolina",
  "us-tn": "Tennessee",
  "us-al": "Alabama",
  "us-ar": "Arkansas",
  uk: "UK",
  ca: "Canada",
};

export function humanizeCitation(fileLegalId: string): string {
  if (!fileLegalId.includes(":")) return fileLegalId;
  const [jurisdiction, body] = fileLegalId.split(":") as [string, string];
  const parts = body.split("/");
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

  if (kind === "policies") {
    const head = JURISDICTION_LABELS[jurisdiction] ?? jurisdiction;
    const crumbs = rest.map((seg) => seg.replace(/-/g, " "));
    return [head, ...crumbs].join(" · ");
  }

  return `${JURISDICTION_LABELS[jurisdiction] ?? jurisdiction} · ${body}`;
}

const KIND_SINGULAR: Record<string, string> = {
  regulations: "regulation",
  statutes: "statute",
  policies: "policy",
  guidance: "guidance",
  bills: "bill",
};

/**
 * Resolve a file legal ID into a public URL on the Axiom app where the user
 * can read the underlying statute/regulation text. Mirrors the canonical-URL
 * pattern used by axiom-foundation.org's metadata builder:
 *   `us-co:regulations/10-ccr-2506-1/4.207.3`
 *     → https://app.axiom-foundation.org/us-co/regulation/10-ccr-2506-1/4.207.3
 *
 * Returns `null` if the legal ID isn't shaped like a real document path.
 */
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

/**
 * Roll a file legal ID up to its parent "document" — the regulation
 * collection or statute title that owns it (e.g. all `10 CCR 2506-1
 * § 4.207.x` files share document key `us-co:regulations/10-ccr-2506-1`).
 * Used by the picker to group ~116 sibling sections under ~4 documents
 * so the user isn't drowning in a flat list.
 *
 * The user's chosen program file gets its own bucket since it isn't
 * really a regulation — it's the composition that imports them.
 */
export function documentInfo(
  fileLegalId: string,
  ownFileLegalId: string,
): { key: string; label: string } {
  if (fileLegalId === ownFileLegalId) {
    return { key: "__composition", label: "Composition (this program)" };
  }
  const colon = fileLegalId.indexOf(":");
  if (colon < 0) return { key: fileLegalId, label: fileLegalId };
  const jurisdiction = fileLegalId.slice(0, colon);
  const body = fileLegalId.slice(colon + 1);
  const parts = body.split("/").filter(Boolean);
  const kind = parts[0] ?? "";
  const slug = parts[1] ?? "";
  const key = `${jurisdiction}:${kind}/${slug}`;
  if (kind === "regulations") {
    const readable = slug.replace(/-/g, " ").toUpperCase();
    const place =
      jurisdiction === "us-co"
        ? " (Colorado)"
        : jurisdiction === "us"
          ? ""
          : ` (${jurisdiction})`;
    return { key, label: `${readable}${place}` };
  }
  if (kind === "statutes") {
    return { key, label: `${slug} USC` };
  }
  if (kind === "policies") {
    const readable = slug.replace(/-/g, " ");
    const head = jurisdiction === "us" ? "Federal" : jurisdiction.toUpperCase();
    return { key, label: `${head} · ${readable} policy` };
  }
  return { key, label: humanizeCitation(fileLegalId) };
}

/**
 * Tiny mono glyph that conveys a rule/input's flavor in one character.
 * Replaces the multi-badge soup of dtype + depth + terminal indicators with
 * one consistent visual.
 */
export function dtypeGlyph(dtype: string | null | undefined): {
  glyph: string;
  cls: string;
  title: string;
} {
  const d = (dtype ?? "").toLowerCase();
  if (d === "judgment") return { glyph: "⊢", cls: "glyph-judgment", title: "Judgment" };
  if (d === "money") return { glyph: "$", cls: "glyph-money", title: "Money" };
  if (d === "decimal") return { glyph: "ƒ", cls: "glyph-decimal", title: "Decimal" };
  if (d === "integer") return { glyph: "#", cls: "glyph-integer", title: "Integer" };
  if (d === "boolean") return { glyph: "□", cls: "glyph-boolean", title: "Boolean" };
  if (d === "date") return { glyph: "▦", cls: "glyph-date", title: "Date" };
  return { glyph: "•", cls: "glyph-default", title: dtype ?? "" };
}
