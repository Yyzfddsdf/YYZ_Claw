import "./numeric-input.css";

function normalizeNumberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder = "",
  disabled = false,
  className = "",
  "aria-label": ariaLabel
}) {
  const numericStep = Number(step ?? 1);
  const normalizedStep = Number.isFinite(numericStep) && numericStep > 0 ? numericStep : 1;

  function commit(nextValue) {
    if (disabled) {
      return;
    }

    let number = normalizeNumberValue(nextValue);
    const minNumber = Number(min);
    const maxNumber = Number(max);
    if (Number.isFinite(minNumber)) {
      number = Math.max(minNumber, number);
    }
    if (Number.isFinite(maxNumber)) {
      number = Math.min(maxNumber, number);
    }
    onChange?.(String(number));
  }

  function adjust(direction) {
    const current = value === "" || value === null || value === undefined
      ? normalizeNumberValue(min ?? 0)
      : normalizeNumberValue(value);
    commit(current + direction * normalizedStep);
  }

  return (
    <div className={`numeric-input ${className}`.trim()}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={normalizedStep}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange?.(event.target.value)}
      />
      <div className="numeric-input-actions" aria-hidden="true">
        <button type="button" tabIndex={-1} onClick={() => adjust(1)} disabled={disabled}>
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M6 2.5v7M2.5 6h7" />
          </svg>
        </button>
        <button type="button" tabIndex={-1} onClick={() => adjust(-1)} disabled={disabled}>
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M2.5 6h7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
