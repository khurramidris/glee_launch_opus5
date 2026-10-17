interface GroupReplyParticipant {
  id: string;
  name: string;
}

interface GroupReplyControlsProps {
  participants: GroupReplyParticipant[];
  /** Characters chosen to answer the next message; empty means Glee decides. */
  selectedIds: string[];
  disabled?: boolean;
  onChangeSelected: (ids: string[]) => void;
  onRequestReply: (characterId: string) => void;
}

/**
 * Lets the user steer a group chat: pick who answers the next message, or ask
 * one character to speak without sending anything.
 */
export function GroupReplyControls({
  participants,
  selectedIds,
  disabled,
  onChangeSelected,
  onRequestReply,
}: GroupReplyControlsProps) {
  if (participants.length < 2) {
    return null;
  }

  function toggle(characterId: string) {
    onChangeSelected(
      selectedIds.includes(characterId)
        ? selectedIds.filter((id) => id !== characterId)
        : [...selectedIds, characterId],
    );
  }

  return (
    <div className="group-reply-controls">
      <div className="group-reply-row" role="group" aria-label="Who answers next">
        <span className="group-reply-label">Who answers</span>
        <button
          type="button"
          className={`group-reply-chip${selectedIds.length === 0 ? " active" : ""}`}
          aria-pressed={selectedIds.length === 0}
          onClick={() => onChangeSelected([])}
        >
          Automatic
        </button>
        {participants.map((participant) => (
          <button
            key={participant.id}
            type="button"
            className={`group-reply-chip${selectedIds.includes(participant.id) ? " active" : ""}`}
            aria-pressed={selectedIds.includes(participant.id)}
            onClick={() => toggle(participant.id)}
          >
            {participant.name}
          </button>
        ))}
      </div>
      <label className="group-reply-row">
        <span className="group-reply-label">Let someone speak</span>
        <select
          className="search-input"
          value=""
          disabled={disabled}
          aria-label="Ask a character to speak"
          onChange={(event) => {
            if (event.target.value) {
              onRequestReply(event.target.value);
            }
          }}
        >
          <option value="">Choose a character...</option>
          {participants.map((participant) => (
            <option key={participant.id} value={participant.id}>
              {participant.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
