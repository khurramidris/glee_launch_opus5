# Memory

Glee gives characters four kinds of memory. They work together, and all of
them live in the local database on your computer.

| Layer | What it holds | Lasts |
| --- | --- | --- |
| Recent messages | The last stretch of the conversation, sent as-is | While the messages are in the prompt window |
| Rolling summary | A short summary of older messages, written automatically as a chat grows | That chat |
| Memory items | Short statements such as "Sam is allergic to peanuts" | Until you delete them |
| Message recall | Old messages that match what you just said | That chat |

The model has an 8192-token context, so only a small slice of each layer fits
in a reply. Memory items are the compact, long-lived layer: they are what lets
a character remember you in a new chat or after a restart.

## Memory items

An item is one third-person sentence with a kind, an importance from 1 to 5,
and an owner.

**Kinds:** fact, preference, event, relationship, promise.

**Scopes decide who can remember an item:**

- **About you (`user`)**: facts about you. Every character can recall them.
- **Character (`character`)**: what one character knows or shares with you,
  such as events you lived through together, promises, and how they feel about
  you. It follows that character into every chat. Other characters never see
  it, including in group chats.
- **Chat (`chat`)**: details that only matter inside one story. It stays in
  that chat.

An item can be **pinned**, which means it is always included when its owner is
in the conversation, regardless of what you are talking about.

## How memories are made

After every few new messages (six or more) in a chat, once a reply is finished
and nothing else is waiting, Glee asks the local model to read the newest
unprocessed messages (about 3500 characters at most) and answer in JSON with
three lists: things to add, things to update, and things to remove. The model
also sees the existing items most similar to the conversation, so it updates an
item instead of writing a second copy.

Safeguards:

- The run happens in the background and never delays or blocks a reply. It
  stops if you start a new message.
- Each run adds at most six items of up to 200 characters, and archives at
  most three.
- Entries that are malformed, written in first person, too short, or about a
  character who is not in the chat are dropped. The parser also copes with
  reasoning blocks, code fences, trailing commas, and cut-off output.
- Items that repeat an existing one (same wording, near-identical wording, or
  nearly the same meaning by embedding similarity) are merged into it.
- Pinned items are never edited or removed by the model, and an item the model
  archived is not brought back by a later run.
- A small cursor per chat records how far extraction has read, so messages are
  not processed twice.

You can also add your own items at any time. Manual items behave exactly like
extracted ones.

## How memories are used

When a character is about to reply, Glee picks the items that character may
recall: your `user` items, that character's own `character` items, and the
`chat` items of the open chat. Pinned items come first. The rest are ranked by:

- how well they match your latest message and the last few messages (by
  meaning when the embedding service is available, and always by shared
  words),
- their importance,
- how recently they were created, edited, or recalled. Old items fade, but
  important and pinned ones never fade completely.

At most six items and about 600 characters are added to the reply prompt, as
lines starting with `Remembered:`. Items that do not match the conversation are
left out, so a long memory list does not crowd the prompt. Items that were
used are marked as recalled, which keeps frequently useful items fresh.

Group chats follow the same rules per speaker: each character recalls only its
own `character` items plus the shared `user` and `chat` items.

When items are available for a chat, the older keyword-based "facts" are no
longer added to the prompt. The rolling summary is still used, and message
recall still adds old messages that are not already covered by an item.

If the embedding service is not running, items are matched by words only and
indexing resumes when it returns.

## Seeing and controlling memories

Open the chat's Memory tab to see what the open chat can recall, or Settings
to see everything and filter by character. From there you can:

- search and filter by kind of owner or character,
- edit the text or kind of an item,
- pin or unpin an item and change its importance,
- add a memory,
- delete one item, or **Forget all** for a group (you, one character, or one
  chat), always after a confirmation.

Items archived by the model are hidden by default and can be restored.

## What is stored and where

- Items, their importance and pin state, usage counts, and the extraction
  cursor are in the `memory_items` and `memory_extraction_state` tables of
  Glee's SQLite database. Item embeddings are in `memory_item_embeddings`.
- Nothing is sent anywhere. Extraction and embeddings use the models running on
  your computer.
- Backups include memory items, and restoring a backup restores them.
- Deleting a character deletes its `character` items. Deleting a chat, or
  clearing its history, deletes its `chat` items. `user` items are only removed
  when you remove them.
- The sibling `chat_memory` table still holds each chat's rolling summary.

## Tuning

The values live in `src-tauri/src/db/memory_items.rs` (retrieval, duplicate
detection, extraction window) and `src/features/memory/memory-extraction.ts`
(throttle, per-run limits, prompt).
