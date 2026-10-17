import { useMemo, useState } from "react";
import type {
  CreateMemoryItemPayload,
  DeleteMemoryItemsForPayload,
  MemoryItem,
  MemoryKind,
  MemoryScope,
} from "../../types";
import type { MemoryItemPatch } from "../../stores/memory-store";

export interface MemoryManagerCharacter {
  id: string;
  name: string;
}

export interface MemoryManagerProps {
  items: MemoryItem[];
  /** Characters that can own a memory; also names the groups. */
  characters: MemoryManagerCharacter[];
  /** The open chat. Enables adding "this chat" memories and the chat-only wording. */
  chatId?: string | null;
  /** Names chat groups when memories from several chats are listed. */
  chatTitles?: Record<string, string>;
  /** Shows a filter by character, for the all-memories view. */
  showCharacterFilter?: boolean;
  /** Character filter to start with. */
  initialCharacterId?: string;
  loading?: boolean;
  error?: string | null;
  createItem: (payload: CreateMemoryItemPayload) => Promise<MemoryItem | null>;
  updateItem: (id: string, patch: MemoryItemPatch) => Promise<MemoryItem | null>;
  deleteItem: (id: string) => Promise<boolean>;
  forget: (target: DeleteMemoryItemsForPayload) => Promise<number | null>;
  clearError?: () => void;
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  event: "Event",
  relationship: "Relationship",
  promise: "Promise",
};

const KINDS = Object.keys(KIND_LABELS) as MemoryKind[];
const MAX_CONTENT_CHARS = 500;
const IMPORTANCE_LABELS = ["Minor", "Low", "Normal", "High", "Essential"];

interface MemoryGroup {
  key: string;
  title: string;
  hint: string;
  items: MemoryItem[];
  forgetTarget: DeleteMemoryItemsForPayload;
}

function matchesQuery(item: MemoryItem, query: string): boolean {
  return !query || item.content.toLowerCase().includes(query) || item.kind.includes(query);
}

/** Groups items by who holds them: the user, each character, then each chat. */
export function groupMemoryItems(
  items: MemoryItem[],
  characters: MemoryManagerCharacter[],
  chatTitles: Record<string, string> = {},
): MemoryGroup[] {
  const names = new Map(characters.map((character) => [character.id, character.name]));
  const groups: MemoryGroup[] = [];

  const userItems = items.filter((item) => item.scope === "user");
  if (userItems.length > 0) {
    groups.push({
      key: "user",
      title: "About you",
      hint: "Shared with every character",
      items: userItems,
      forgetTarget: { scope: "user" },
    });
  }

  const byCharacter = new Map<string, MemoryItem[]>();
  for (const item of items.filter((entry) => entry.scope === "character" && entry.characterId)) {
    const list = byCharacter.get(item.characterId as string) ?? [];
    list.push(item);
    byCharacter.set(item.characterId as string, list);
  }
  [...byCharacter.entries()]
    .sort((left, right) =>
      (names.get(left[0]) ?? "").localeCompare(names.get(right[0]) ?? ""),
    )
    .forEach(([characterId, list]) => {
      const name = names.get(characterId) ?? "Unknown character";
      groups.push({
        key: `character:${characterId}`,
        title: name,
        hint: `Only ${name} remembers this, in every chat`,
        items: list,
        forgetTarget: { characterId },
      });
    });

  const byChat = new Map<string, MemoryItem[]>();
  for (const item of items.filter((entry) => entry.scope === "chat" && entry.chatId)) {
    const list = byChat.get(item.chatId as string) ?? [];
    list.push(item);
    byChat.set(item.chatId as string, list);
  }
  [...byChat.entries()].forEach(([chatId, list]) => {
    groups.push({
      key: `chat:${chatId}`,
      title: chatTitles[chatId] ? `Chat: ${chatTitles[chatId]}` : "This chat",
      hint: "Only used in this chat",
      items: list,
      forgetTarget: { chatId },
    });
  });
  return groups;
}

function ImportanceSelect({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <select
      className="search-input memory-importance"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {IMPORTANCE_LABELS.map((text, index) => (
        <option key={text} value={index + 1}>
          {index + 1} - {text}
        </option>
      ))}
    </select>
  );
}

function MemoryRow({
  item,
  confirming,
  onConfirm,
  updateItem,
  deleteItem,
}: {
  item: MemoryItem;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  updateItem: MemoryManagerProps["updateItem"];
  deleteItem: MemoryManagerProps["deleteItem"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [kind, setKind] = useState<MemoryKind>(item.kind);
  const [saving, setSaving] = useState(false);

  async function save() {
    const content = draft.trim();
    if (!content) {
      return;
    }
    setSaving(true);
    const saved = await updateItem(item.id, { content, kind });
    setSaving(false);
    if (saved) {
      setEditing(false);
    }
  }

  return (
    <li className={`memory-item${item.archived ? " archived" : ""}${item.pinned ? " pinned" : ""}`}>
      <div className="memory-item-main">
        <span className={`memory-kind memory-kind-${item.kind}`}>{KIND_LABELS[item.kind]}</span>
        {editing ? (
          <div className="memory-edit">
            <textarea
              className="search-input"
              aria-label="Memory text"
              rows={2}
              maxLength={MAX_CONTENT_CHARS}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <select
              className="search-input"
              aria-label="Memory type"
              value={kind}
              onChange={(event) => setKind(event.target.value as MemoryKind)}
            >
              {KINDS.map((entry) => (
                <option key={entry} value={entry}>
                  {KIND_LABELS[entry]}
                </option>
              ))}
            </select>
            <div className="memory-actions">
              <button type="button" className="primary" disabled={saving || !draft.trim()} onClick={() => void save()}>
                Save
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setDraft(item.content);
                  setKind(item.kind);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="memory-text">{item.content}</p>
        )}
      </div>

      {!editing && (
        <div className="memory-item-controls">
          <ImportanceSelect
            value={item.importance}
            label={`Importance of: ${item.content}`}
            onChange={(importance) => void updateItem(item.id, { importance })}
          />
          <button
            type="button"
            className={`ghost memory-pin${item.pinned ? " active" : ""}`}
            aria-pressed={item.pinned}
            title="Pinned memories are always remembered"
            onClick={() => void updateItem(item.id, { pinned: !item.pinned })}
          >
            {item.pinned ? "Pinned" : "Pin"}
          </button>
          {item.archived ? (
            <button type="button" className="ghost" onClick={() => void updateItem(item.id, { archived: false })}>
              Restore
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {confirming ? (
            <span className="memory-confirm" role="group" aria-label="Confirm delete">
              <span>Delete?</span>
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  onConfirm(null);
                  void deleteItem(item.id);
                }}
              >
                Yes
              </button>
              <button type="button" className="ghost" onClick={() => onConfirm(null)}>
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ghost danger"
              aria-label={`Delete: ${item.content}`}
              onClick={() => onConfirm(`item:${item.id}`)}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function AddMemoryForm({
  characters,
  chatId,
  createItem,
  onDone,
}: {
  characters: MemoryManagerCharacter[];
  chatId?: string | null;
  createItem: MemoryManagerProps["createItem"];
  onDone: () => void;
}) {
  const [scope, setScope] = useState<MemoryScope>("user");
  const [characterId, setCharacterId] = useState(characters[0]?.id ?? "");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [importance, setImportance] = useState(3);
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);

  const needsCharacter = scope === "character";
  const canSave = content.trim().length > 0 && (!needsCharacter || Boolean(characterId));

  async function submit() {
    if (!canSave) {
      return;
    }
    setSaving(true);
    const created = await createItem({
      scope,
      ...(needsCharacter ? { characterId } : {}),
      ...(scope === "chat" && chatId ? { chatId } : {}),
      kind,
      content: content.trim(),
      importance,
      pinned,
    });
    setSaving(false);
    if (created) {
      setContent("");
      setPinned(false);
      onDone();
    }
  }

  return (
    <form
      className="memory-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="search-input"
        aria-label="New memory"
        placeholder='Write it as a short statement, for example "Sam is allergic to peanuts"'
        rows={2}
        maxLength={MAX_CONTENT_CHARS}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="memory-add-row">
        <select
          className="search-input"
          aria-label="Who remembers it"
          value={scope}
          onChange={(event) => setScope(event.target.value as MemoryScope)}
        >
          <option value="user">About you (all characters)</option>
          <option value="character" disabled={characters.length === 0}>
            One character
          </option>
          {chatId && <option value="chat">Only this chat</option>}
        </select>
        {needsCharacter && (
          <select
            className="search-input"
            aria-label="Character"
            value={characterId}
            onChange={(event) => setCharacterId(event.target.value)}
          >
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        )}
        <select
          className="search-input"
          aria-label="New memory type"
          value={kind}
          onChange={(event) => setKind(event.target.value as MemoryKind)}
        >
          {KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_LABELS[entry]}
            </option>
          ))}
        </select>
        <ImportanceSelect value={importance} label="New memory importance" onChange={setImportance} />
      </div>
      <label className="memory-pin-option">
        <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
        Always remember this
      </label>
      <div className="memory-actions">
        <button type="submit" className="primary" disabled={!canSave || saving}>
          {saving ? "Saving..." : "Save memory"}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Lists what the characters remember, grouped by who holds it, and lets the
 * user search, edit, pin, rate, add, delete, or forget everything in a group.
 * It holds no data of its own: feed it the result of `useMemoryItems`.
 */
export function MemoryManager({
  items,
  characters,
  chatId,
  chatTitles,
  showCharacterFilter = false,
  initialCharacterId,
  loading,
  error,
  createItem,
  updateItem,
  deleteItem,
  forget,
  clearError,
}: MemoryManagerProps) {
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | MemoryScope>("all");
  const [characterFilter, setCharacterFilter] = useState(initialCharacterId ?? "all");
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (scopeFilter !== "all" && item.scope !== scopeFilter) {
        return false;
      }
      if (characterFilter !== "all") {
        // A character filter keeps that character's items and the user items it can also recall.
        if (item.scope === "chat") {
          return false;
        }
        if (item.scope === "character" && item.characterId !== characterFilter) {
          return false;
        }
      }
      return matchesQuery(item, needle);
    });
  }, [items, query, scopeFilter, characterFilter]);

  const groups = useMemo(
    () => groupMemoryItems(visible, characters, chatId ? undefined : chatTitles),
    [visible, characters, chatId, chatTitles],
  );
  const filtering = query.trim() !== "" || scopeFilter !== "all" || characterFilter !== "all";

  return (
    <div className="memory-manager">
      <div className="memory-toolbar">
        <input
          className="search-input"
          type="search"
          aria-label="Search memories"
          placeholder="Search memories"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="search-input"
          aria-label="Filter by kind of owner"
          value={scopeFilter}
          onChange={(event) => setScopeFilter(event.target.value as "all" | MemoryScope)}
        >
          <option value="all">Everything</option>
          <option value="user">About you</option>
          <option value="character">Characters</option>
          <option value="chat">Chats</option>
        </select>
        {showCharacterFilter && (
          <select
            className="search-input"
            aria-label="Filter by character"
            value={characterFilter}
            onChange={(event) => setCharacterFilter(event.target.value)}
          >
            <option value="all">All characters</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="ghost" onClick={() => setAdding((current) => !current)}>
          {adding ? "Close" : "Add a memory"}
        </button>
      </div>

      {error && (
        <p className="memory-error" role="alert">
          {error}
          {clearError && (
            <button type="button" className="ghost" onClick={clearError}>
              Dismiss
            </button>
          )}
        </p>
      )}

      {adding && (
        <AddMemoryForm
          characters={characters}
          chatId={chatId}
          createItem={createItem}
          onDone={() => setAdding(false)}
        />
      )}

      {loading && items.length === 0 && <p className="empty-note">Loading memories...</p>}
      {!loading && groups.length === 0 && (
        <p className="empty-note">
          {filtering
            ? "No memories match."
            : "Nothing remembered yet. Memories appear here as you chat, and you can add your own."}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.key} className="memory-group" aria-label={group.title}>
          <header className="memory-group-head">
            <div>
              <strong>{group.title}</strong>
              <small>{group.hint}</small>
            </div>
            {confirming === `forget:${group.key}` ? (
              <span className="memory-confirm" role="group" aria-label={`Confirm forget all for ${group.title}`}>
                <span>Forget every memory here?</span>
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => {
                    setConfirming(null);
                    void forget(group.forgetTarget);
                  }}
                >
                  Yes
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(null)}>
                  No
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="ghost danger"
                aria-label={`Forget all: ${group.title}`}
                onClick={() => setConfirming(`forget:${group.key}`)}
              >
                Forget all
              </button>
            )}
          </header>
          <ul className="memory-list">
            {group.items.map((item) => (
              <MemoryRow
                key={item.id}
                item={item}
                confirming={confirming === `item:${item.id}`}
                onConfirm={setConfirming}
                updateItem={updateItem}
                deleteItem={deleteItem}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
