interface FieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  error?: string;
}

export function Field({ label, type, value, onChange, autoComplete, error }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-[var(--color-ink)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="input"
      />
      {error && <span className="mt-1 block text-xs text-[var(--color-danger)]">{error}</span>}
    </label>
  );
}
