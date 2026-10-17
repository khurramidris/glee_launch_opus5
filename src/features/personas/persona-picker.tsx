import type { Persona } from "../../types";

interface PersonaPickerProps {
  personas: Persona[];
  selectedId: string | undefined;
  defaultName: string;
  disabled?: boolean;
  onSelect: (personaId: string | null) => void;
}

/** "Playing as" selector shown above the message field. Hidden until a persona exists. */
export function PersonaPicker({
  personas,
  selectedId,
  defaultName,
  disabled,
  onSelect,
}: PersonaPickerProps) {
  if (personas.length === 0) {
    return null;
  }
  const value = personas.some((persona) => persona.id === selectedId) ? selectedId : "";
  return (
    <label className="composer-tool">
      <span>Playing as</span>
      <select
        className="search-input"
        value={value}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value || null)}
      >
        <option value="">{defaultName || "Default identity"}</option>
        {personas.map((persona) => (
          <option key={persona.id} value={persona.id}>
            {persona.name}
          </option>
        ))}
      </select>
    </label>
  );
}
