import type { FormEvent, ReactNode } from "react";
import type { Character } from "../../types";
import type { CharacterDraft, CharacterEditorMode } from "../../stores/character-store";
import { useCharacterPortrait } from "./use-character-portrait";

interface CharacterEditorPanelProps {
  editorMode: CharacterEditorMode;
  draft: CharacterDraft;
  savingCharacter: boolean;
  activeCharacter?: Character;
  onChange: <K extends keyof CharacterDraft>(field: K, value: CharacterDraft[K]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onEditCurrent?: () => void;
  onChoosePortrait: () => void | Promise<void>;
  onClearPortrait: () => void;
}

interface CharacterFieldProps {
  label: string;
  placeholder: string;
  value: string;
  helper?: string;
  rows?: number;
  span?: "full" | "half";
  onChange: (value: string) => void;
}

function CharacterField({
  label,
  placeholder,
  value,
  helper,
  rows,
  span = "half",
  onChange,
}: CharacterFieldProps) {
  if (rows) {
    return (
      <label className={`character-editor-field${span === "full" ? " full" : ""}`}>
        <span>{label}</span>
        <textarea
          className="search-input"
          rows={rows}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {helper ? <small>{helper}</small> : null}
      </label>
    );
  }

  return (
    <label className={`character-editor-field${span === "full" ? " full" : ""}`}>
      <span>{label}</span>
      <input
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

interface CharacterSectionProps {
  step: string;
  title: string;
  description: string;
  tone?: "primary" | "advanced";
  children: ReactNode;
}

function CharacterSection({
  step,
  title,
  description,
  tone = "primary",
  children,
}: CharacterSectionProps) {
  return (
    <section className={`character-editor-section${tone === "advanced" ? " advanced" : ""}`}>
      <div className="character-editor-section-head">
        <div className="character-editor-section-meta">
          <span className="character-editor-step">{step}</span>
          <span className={`character-editor-tone${tone === "advanced" ? " advanced" : ""}`}>
            {tone === "advanced" ? "Advanced" : "Essential"}
          </span>
        </div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function fileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function CharacterEditorPanel({
  editorMode,
  draft,
  savingCharacter,
  activeCharacter,
  onChange,
  onSubmit,
  onCancel,
  onEditCurrent,
  onChoosePortrait,
  onClearPortrait,
}: CharacterEditorPanelProps) {
  const previewSrc = useCharacterPortrait(draft.avatar);

  return (
    <form onSubmit={onSubmit} className="character-editor-form character-editor">
      <div className="character-editor-header">
        <div>
          <strong>{editorMode === "create" ? "Create Character" : "Edit Character"}</strong>
          <small>Build voice, scene, and relationship cues instead of one giant blob.</small>
        </div>
      </div>

      <section className="character-editor-intro">
        <div className="character-editor-intro-copy">
          <span className="character-editor-intro-kicker">Studio approach</span>
          <h3>Start with identity, then anchor scene, then prove the voice.</h3>
          <p>Strong character cards use concrete cues and example lines. Keep advanced instructions narrow and only use them when the core writing is not enough.</p>
        </div>
        <div className="character-editor-intro-points">
          <span>Name + identity first</span>
          <span>Scene and boundaries second</span>
          <span>Examples beat adjectives</span>
        </div>
      </section>

      <section className="character-editor-guidance">
        <article className="character-editor-guidance-card">
          <span className="character-editor-guidance-kicker">High signal</span>
          <h4>What most strongly shapes replies</h4>
          <ul className="character-editor-guidance-list">
            <li>Core identity that reads like a person, not a spec sheet</li>
            <li>Scenario framing that explains the current world and stakes</li>
            <li>Example dialogue that proves the voice in practice</li>
          </ul>
        </article>
        <article className="character-editor-guidance-card subtle">
          <span className="character-editor-guidance-kicker">Use sparingly</span>
          <h4>What to keep tight and precise</h4>
          <ul className="character-editor-guidance-list">
            <li>Boundaries for hard constraints, not broad personality notes</li>
            <li>Advanced instructions only when natural writing still drifts</li>
            <li>Creator notes for sharing context with other card users</li>
          </ul>
        </article>
      </section>

      <CharacterSection
        step="01"
        title="Identity"
        description="Who the character is at a core level, and what defines them immediately."
      >
        <div className="character-portrait-card">
          <div className="character-portrait-preview">
            {previewSrc ? (
              <img src={previewSrc} alt={`${draft.name || "Character"} portrait preview`} />
            ) : (
              <div className="character-portrait-fallback">
                <span>{draft.name.trim().slice(0, 1).toUpperCase() || "G"}</span>
              </div>
            )}
          </div>
          <div className="character-portrait-copy">
            <span className="character-editor-guidance-kicker">Portrait</span>
            <h4>Attach the card image users will share.</h4>
            <p>
              PNG portraits are the compatibility-safe path for serious card export. Imported PNG
              cards fill this automatically.
            </p>
            <div className="character-portrait-actions">
              <button type="button" className="ghost" onClick={() => void onChoosePortrait()}>
                Choose PNG
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!draft.avatar.trim()}
                onClick={onClearPortrait}
              >
                Remove
              </button>
            </div>
            <small>
              {draft.avatar.trim()
                ? `Selected: ${fileBaseName(draft.avatar)}`
                : "No portrait selected yet."}
            </small>
          </div>
        </div>
        <div className="character-editor-grid">
          <CharacterField
            label="Name"
            placeholder="Priyanka"
            value={draft.name}
            helper="Use the exact display name users should see in chat."
            onChange={(value) => onChange("name", value)}
          />
          <CharacterField
            label="Traits"
            placeholder="flirty, impulsive, observant"
            value={draft.tags}
            helper="Short tags help scanning in the library and inspector."
            onChange={(value) => onChange("tags", value)}
          />
          <CharacterField
            label="Core Identity"
            placeholder="How the character presents themself and what defines them."
            rows={3}
            span="full"
            value={draft.description}
            helper="Write the immediate impression: personality, social energy, and what makes them distinct."
            onChange={(value) => onChange("description", value)}
          />
          <CharacterField
            label="Personality"
            placeholder="How the character tends to think, feel, and react."
            rows={3}
            value={draft.personality}
            helper="This maps directly to standard character-card personality."
            onChange={(value) => onChange("personality", value)}
          />
          <CharacterField
            label="Backstory"
            placeholder="Important past experiences that shape the character."
            rows={3}
            value={draft.backstory}
            helper="Only include history that should influence how they react in chat."
            onChange={(value) => onChange("backstory", value)}
          />
        </div>
      </CharacterSection>

      <CharacterSection
        step="02"
        title="Scene"
        description="Set the world, the framing, and the boundaries for how the character should behave."
      >
        <div className="character-editor-grid">
          <CharacterField
            label="Scenario"
            placeholder="Current premise, setting, or roleplay framing."
            rows={3}
            span="full"
            value={draft.scenario}
            helper="Describe the current world or roleplay setup, not the whole lore bible."
            onChange={(value) => onChange("scenario", value)}
          />
          <CharacterField
            label="Boundaries"
            placeholder="What the character will not do or tone they should avoid."
            rows={2}
            span="full"
            value={draft.boundaries}
            helper="Use for hard edges, not generic style notes."
            onChange={(value) => onChange("boundaries", value)}
          />
          <CharacterField
            label="Greeting"
            placeholder="Opening line / first-turn message"
            value={draft.greeting}
            helper="This becomes the opening assistant message in a fresh chat."
            onChange={(value) => onChange("greeting", value)}
          />
          <CharacterField
            label="Alternate Greetings"
            placeholder={"Another opening message\n\n---\n\nA different opening message"}
            rows={5}
            span="full"
            value={draft.alternateGreetings}
            helper="Optional. Put --- on its own line between openings; commas and line breaks are preserved."
            onChange={(value) => onChange("alternateGreetings", value)}
          />
        </div>
      </CharacterSection>

      <details className="character-editor-more">
        <summary>
          <span>
            <strong>More character details</strong>
            <small>Voice examples, likes, boundaries, and shareable card details</small>
          </span>
          <span aria-hidden="true">+</span>
        </summary>
      <CharacterSection
        step="03"
        title="Voice"
        description="Define how the character sounds in moment-to-moment conversation."
      >
        <div className="character-editor-grid">
          <CharacterField
            label="Speech Style"
            placeholder="Short, playful, formal, teasing, poetic..."
            rows={2}
            value={draft.speechStyle}
            helper="Describe cadence, tone, and vocabulary. Keep it human-readable."
            onChange={(value) => onChange("speechStyle", value)}
          />
          <CharacterField
            label="Example Dialogue"
            placeholder="User: ... / Character: ..."
            rows={4}
            span="full"
            value={draft.exampleDialogue}
            helper="Concrete dialogue is the highest-signal way to lock the voice."
            onChange={(value) => onChange("exampleDialogue", value)}
          />
        </div>
      </CharacterSection>

      <CharacterSection
        step="04"
        title="Dynamics"
        description="Show what the character leans toward, rejects, or reacts strongly to."
      >
        <div className="character-editor-grid two-up">
          <CharacterField
            label="Likes"
            placeholder="honesty, danger, praise"
            value={draft.likes}
            helper="List emotional pulls or recurring interests."
            onChange={(value) => onChange("likes", value)}
          />
          <CharacterField
            label="Dislikes"
            placeholder="evasiveness, boredom, disrespect"
            value={draft.dislikes}
            helper="List social triggers, taboos, or frustrations."
            onChange={(value) => onChange("dislikes", value)}
          />
        </div>
      </CharacterSection>

      <CharacterSection
        step="05"
        title="Advanced Controls"
        description="Only use these when the natural writing above is not enough."
        tone="advanced"
      >
        <div className="character-editor-grid">
          <CharacterField
            label="Advanced Instructions"
            placeholder="Machine-facing constraints for the model"
            rows={3}
            span="full"
            value={draft.systemPrompt}
            helper="Reserve this for precise constraints or edge cases. Do not restate the whole character here."
            onChange={(value) => onChange("systemPrompt", value)}
          />
          <CharacterField
            label="Post-History Instructions"
            placeholder="High-priority instructions that should weigh heavily on the next reply."
            rows={3}
            span="full"
            value={draft.postHistoryInstructions}
            helper="Maps to standard post-history instructions for card compatibility."
            onChange={(value) => onChange("postHistoryInstructions", value)}
          />
          <CharacterField
            label="Creator Notes"
            placeholder="Notes for people who import or use this card."
            rows={2}
            span="full"
            value={draft.creatorNotes}
            helper="These notes travel with exported cards. They do not control character replies."
            onChange={(value) => onChange("creatorNotes", value)}
          />
          <CharacterField
            label="Creator"
            placeholder="Card author name"
            value={draft.creator}
            helper="Standard card metadata. Useful for sharing and attribution."
            onChange={(value) => onChange("creator", value)}
          />
          <CharacterField
            label="Character Version"
            placeholder="1.0"
            value={draft.characterVersion}
            helper="Standard card version label for iterative releases."
            onChange={(value) => onChange("characterVersion", value)}
          />
        </div>
      </CharacterSection>
      </details>

      <div className="character-editor-footer">
        <div className="character-editor-footer-copy">
          <strong>{editorMode === "create" ? "Ready to create" : "Ready to update"}</strong>
          <small>Start simple. You can add more character details whenever you need them.</small>
        </div>
        <div className="editor-action-row">
          <button className="primary" type="submit" disabled={savingCharacter}>
            {savingCharacter ? "Saving..." : editorMode === "create" ? "Create Character" : "Save Changes"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          {activeCharacter && editorMode === "create" && onEditCurrent && (
            <button type="button" className="ghost" onClick={onEditCurrent}>
              Edit Current
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
