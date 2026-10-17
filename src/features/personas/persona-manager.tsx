import type { FormEvent } from "react";
import type { Persona, PersonaDraft } from "../../types";

interface PersonaManagerProps {
  personas: Persona[];
  editingPersonaId: string | null;
  draft: PersonaDraft;
  saving: boolean;
  onChangeDraft: (patch: Partial<PersonaDraft>) => void;
  onEdit: (persona: Persona) => void;
  onCancelEdit: () => void;
  onSave: () => void | Promise<void>;
  onDelete: (persona: Persona) => void | Promise<void>;
}

export function PersonaManager({
  personas,
  editingPersonaId,
  draft,
  saving,
  onChangeDraft,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: PersonaManagerProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave();
  }

  return (
    <section className="detail-section settings-section">
      <h4>Personas</h4>
      <p className="settings-note">
        A persona is another version of you, such as a character you roleplay as. Pick one for a
        chat from the box above the message field; chats without one use your default identity.
      </p>
      <div className="preset-list">
        {personas.length === 0 && <p className="empty-note">No personas yet.</p>}
        {personas.map((persona) => (
          <div
            key={persona.id}
            className={`preset-row${persona.id === editingPersonaId ? " active" : ""}`}
          >
            <button type="button" className="preset-main" onClick={() => onEdit(persona)}>
              <strong>{persona.name}</strong>
              <small>{persona.about || "No description"}</small>
            </button>
            <div className="preset-row-actions">
              <button type="button" className="ghost" onClick={() => onEdit(persona)}>
                Edit
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (window.confirm(`Delete the persona "${persona.name}"?`)) {
                    void onDelete(persona);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <form className="preset-form" onSubmit={submit}>
        <label className="preset-field">
          <span>Persona name</span>
          <input
            className="search-input"
            placeholder="The name characters call you"
            value={draft.name}
            onChange={(event) => onChangeDraft({ name: event.target.value })}
          />
        </label>
        <label className="preset-field">
          <span>About this persona</span>
          <textarea
            className="search-input"
            rows={3}
            placeholder="Who are they? Appearance, background, role in the story"
            value={draft.about}
            onChange={(event) => onChangeDraft({ about: event.target.value })}
          />
        </label>
        <label className="preset-field">
          <span>How characters should treat them</span>
          <textarea
            className="search-input"
            rows={2}
            placeholder="Tone, manners, or relationship (optional)"
            value={draft.preferences}
            onChange={(event) => onChangeDraft({ preferences: event.target.value })}
          />
        </label>
        <div className="preset-form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving..." : editingPersonaId ? "Update Persona" : "Add Persona"}
          </button>
          {editingPersonaId && (
            <button type="button" className="ghost" onClick={onCancelEdit}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
