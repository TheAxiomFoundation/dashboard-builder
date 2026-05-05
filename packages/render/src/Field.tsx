import type { BaseInputBinding } from "@dashboard-builder/spec";

interface Props {
  binding: BaseInputBinding;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
}

/**
 * A single form field. Widget is inferred from the input's `dtype` unless the
 * spec sets `widget` explicitly. Each widget is intentionally polished:
 *   - currency: $ prefix, tabular numerals
 *   - integer: stepper with +/- buttons
 *   - boolean: real toggle switch (not a bare checkbox)
 *   - select / date / text: large inputs with consistent spacing
 *
 * The label/help/optional unit hint render in a `.field-head` strip above the
 * control so the layout stays predictable across types.
 */
export function Field({ binding, value, onChange }: Props) {
  const widget = binding.widget ?? defaultWidgetFor(binding.dtype);

  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={binding.id}>{binding.label}</label>
        {binding.help && <span className="help">{binding.help}</span>}
      </div>
      <Control binding={binding} widget={widget} value={value} onChange={onChange} />
    </div>
  );
}

function Control({
  binding,
  widget,
  value,
  onChange,
}: Props & { widget: string }) {
  switch (widget) {
    case "checkbox":
    case "switch":
      return (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          className={`switch ${value ? "on" : "off"}`}
          onClick={() => onChange(!value)}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span className="switch-label">{value ? "Yes" : "No"}</span>
        </button>
      );

    case "select":
      return (
        <select
          id={binding.id}
          className="control control-select"
          value={String(value ?? "")}
          onChange={(e) => onChange(coerceSelectValue(binding, e.target.value))}
        >
          {(binding.options ?? []).map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case "currency":
      return (
        <div className="control control-currency">
          <span className="control-prefix" aria-hidden>
            $
          </span>
          <input
            id={binding.id}
            type="number"
            inputMode="decimal"
            step={binding.dtype === "integer" ? 1 : "any"}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onChange(coerceNumber(binding, e.target.value))}
            placeholder="0"
          />
        </div>
      );

    case "number":
      // Integers get a stepper; decimals get a plain number input.
      if (binding.dtype === "integer") {
        const numericValue =
          typeof value === "number" ? value : Number(value ?? 0) || 0;
        return (
          <div className="control control-stepper">
            <button
              type="button"
              className="stepper-btn"
              aria-label="Decrease"
              onClick={() => onChange(Math.max(0, numericValue - 1))}
            >
              −
            </button>
            <input
              id={binding.id}
              type="number"
              inputMode="numeric"
              step={1}
              value={numericValue}
              onChange={(e) => onChange(coerceNumber(binding, e.target.value))}
            />
            <button
              type="button"
              className="stepper-btn"
              aria-label="Increase"
              onClick={() => onChange(numericValue + 1)}
            >
              +
            </button>
          </div>
        );
      }
      return (
        <input
          id={binding.id}
          type="number"
          inputMode="decimal"
          step="any"
          className="control control-number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(coerceNumber(binding, e.target.value))}
        />
      );

    case "date":
      return (
        <input
          id={binding.id}
          type="date"
          className="control control-date"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "text":
    default:
      return (
        <input
          id={binding.id}
          type="text"
          className="control control-text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function defaultWidgetFor(dtype: BaseInputBinding["dtype"]) {
  switch (dtype) {
    case "boolean": return "switch";
    case "money": return "currency";
    case "integer":
    case "decimal": return "number";
    case "date": return "date";
    default: return "text";
  }
}

function coerceNumber(binding: BaseInputBinding, raw: string): number {
  if (raw === "") return 0;
  return binding.dtype === "integer" ? Math.round(Number(raw)) : Number(raw);
}

function coerceSelectValue(binding: BaseInputBinding, raw: string): string | number | boolean {
  if (binding.dtype === "boolean") return raw === "true";
  if (binding.dtype === "integer" || binding.dtype === "decimal" || binding.dtype === "money") {
    return Number(raw);
  }
  return raw;
}
