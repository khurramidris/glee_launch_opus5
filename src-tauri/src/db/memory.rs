use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::errors::{AppError, AppResult};
use crate::types::{ChatMemoryRecord, MemorySnippetRecord, MessageRecord};

use super::messages::assert_expected_epoch;
use super::messages::map_message_row;
use super::{now_rfc3339, Database};

impl Database {
    pub fn get_chat_memory(&self, chat_id: &str) -> AppResult<ChatMemoryRecord> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let connection = self.open_connection()?;
        let exists: i64 =
            connection.query_row("SELECT COUNT(1) FROM chats WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        }

        let record = connection
            .query_row(
                &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
                [id],
                map_chat_memory_row,
            )
            .optional()?;

        Ok(record.unwrap_or(ChatMemoryRecord {
            chat_id: id.to_string(),
            summary: String::new(),
            summary_auto: false,
            summarized_through_message_id: None,
            facts_json: "[]".to_string(),
            facts: Vec::new(),
            updated_at: String::new(),
        }))
    }

    pub fn upsert_chat_memory_at_epoch(
        &self,
        chat_id: &str,
        summary: Option<&str>,
        facts_json: Option<&str>,
        expected_history_epoch: Option<i64>,
    ) -> AppResult<ChatMemoryRecord> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let history_epoch: Option<i64> = transaction
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(history_epoch) = history_epoch else {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        };
        assert_expected_epoch(id, history_epoch, expected_history_epoch)?;

        let existing = transaction
            .query_row(
                &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
                [id],
                map_chat_memory_row,
            )
            .optional()?;

        let next_summary = summary
            .map(str::trim)
            .map(ToOwned::to_owned)
            .or_else(|| existing.as_ref().map(|record| record.summary.clone()))
            .unwrap_or_default();
        // Saving different summary text takes ownership away from the background
        // summariser and restarts its cursor; re-saving the same text keeps both.
        let (next_summary_auto, next_through_message_id) = match existing.as_ref() {
            Some(record) if record.summary == next_summary => (
                record.summary_auto,
                record.summarized_through_message_id.clone(),
            ),
            _ => (false, None),
        };
        let next_facts_json = if let Some(value) = facts_json {
            normalize_facts_json(Some(value))?
        } else if let Some(existing) = existing.as_ref() {
            normalize_facts_json(Some(&existing.facts_json))?
        } else {
            "[]".to_string()
        };
        let now = now_rfc3339();

        transaction.execute(
            "
            INSERT INTO chat_memory (
                chat_id,
                summary,
                facts_json,
                updated_at,
                summary_auto,
                summarized_through_message_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(chat_id) DO UPDATE SET
                summary = excluded.summary,
                facts_json = excluded.facts_json,
                updated_at = excluded.updated_at,
                summary_auto = excluded.summary_auto,
                summarized_through_message_id = excluded.summarized_through_message_id
            ",
            params![
                id,
                next_summary,
                next_facts_json,
                now,
                next_summary_auto,
                next_through_message_id
            ],
        )?;

        let record = transaction.query_row(
            &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
            [id],
            map_chat_memory_row,
        )?;

        transaction.commit()?;
        Ok(record)
    }

    /// Lexical recall over a chat's history. The newest `exclude_recent_messages`
    /// messages and the latest user message never come back: the prompt already
    /// carries them, so recalling them would only repeat what the model sees.
    pub fn resolve_memory_snippets(
        &self,
        chat_id: &str,
        query: &str,
        limit: usize,
        speaker_character_id: Option<&str>,
        retrieval_hints: Option<&str>,
        exclude_recent_messages: usize,
    ) -> AppResult<Vec<MemorySnippetRecord>> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let clean_query = query.trim();
        if clean_query.is_empty() {
            return Err(AppError::Validation(
                "resolve query cannot be empty".to_string(),
            ));
        }

        let preferred_speaker_id = speaker_character_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let retrieval_profile = derive_retrieval_hints_profile(retrieval_hints.unwrap_or_default());

        let max_results = limit.clamp(1, 12);
        let connection = self.open_connection()?;
        let exists: i64 = connection.query_row(
            "SELECT COUNT(1) FROM chats WHERE id = ?1",
            [clean_chat_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::NotFound(format!(
                "chat {clean_chat_id} was not found"
            )));
        }

        let mut statement = connection.prepare(
            "
            SELECT
                id,
                chat_id,
                role,
                content,
                speaker_character_id,
                created_at
            FROM messages
            WHERE chat_id = ?1
              AND LOWER(TRIM(role)) IN ('user', 'assistant')
              AND content NOT LIKE ?2
            ORDER BY created_at DESC, id DESC
            LIMIT 400
            ",
        )?;
        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);
        let rows = statement.query_map(params![clean_chat_id, failure_pattern], map_message_row)?;
        let excluded_ids =
            recall_excluded_message_ids(&connection, clean_chat_id, exclude_recent_messages)?;
        let candidates = rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|candidate| !excluded_ids.contains(&candidate.id))
            .collect::<Vec<_>>();

        let query_lower = clean_query.to_lowercase();
        let query_terms = tokenize_similarity_terms(&query_lower);
        let query_ngrams = build_token_ngrams(&query_terms, 2);
        let query_unique_terms = unique_terms(&query_terms);

        let mut candidate_docs = candidates
            .into_iter()
            .enumerate()
            .filter_map(|(rank, candidate)| {
                let content_lower = candidate.content.to_lowercase();
                if content_lower.trim().is_empty() {
                    return None;
                }
                let content_terms = tokenize_similarity_terms(&content_lower);
                if content_terms.is_empty() {
                    return None;
                }
                let content_term_set = content_terms.iter().cloned().collect::<HashSet<_>>();
                let content_ngrams = build_token_ngrams(&content_terms, 2);
                Some(MemoryCandidateDocument {
                    rank,
                    candidate,
                    content_lower,
                    term_set: content_term_set,
                    ngrams: content_ngrams,
                })
            })
            .collect::<Vec<_>>();

        if candidate_docs.is_empty() {
            return Ok(Vec::new());
        }

        let total_candidates = candidate_docs.len();
        let query_term_weights =
            build_query_term_weights(&query_unique_terms, &candidate_docs, total_candidates);
        let score_context = MemoryScoreContext {
            query_lower: &query_lower,
            query_term_weights: &query_term_weights,
            query_ngrams: &query_ngrams,
            total_candidates,
            preferred_speaker_id,
            retrieval_profile: &retrieval_profile,
        };

        let mut scored = candidate_docs
            .drain(..)
            .filter_map(|candidate_document| {
                let score = score_memory_snippet(&candidate_document, &score_context);
                if score > 0 {
                    Some((score, candidate_document.candidate))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.created_at.cmp(&left.1.created_at))
                .then_with(|| left.1.id.cmp(&right.1.id))
        });

        let mut snippets = Vec::new();
        let mut seen_content = HashSet::new();
        for (score, candidate) in scored {
            let normalized_content = normalize_content_for_dedupe(&candidate.content);
            if !normalized_content.is_empty() && !seen_content.insert(normalized_content) {
                continue;
            }

            snippets.push(MemorySnippetRecord {
                message_id: candidate.id,
                chat_id: candidate.chat_id,
                role: candidate.role,
                content: candidate.content,
                speaker_character_id: candidate.speaker_character_id,
                created_at: candidate.created_at,
                score,
            });

            if snippets.len() >= max_results {
                break;
            }
        }

        Ok(snippets)
    }
}

impl Database {
    /// How many of a chat's newest messages memory recall skips. The prompt's
    /// history window already holds them, so surfacing them as "recalled
    /// memory" would only repeat the conversation back to the model.
    pub(crate) const RECALL_EXCLUDED_RECENT_MESSAGES: usize = 8;
}

/// Ids that recall must not return: the newest `recent` messages of the chat
/// plus its latest user message, which is the turn being answered.
pub(super) fn recall_excluded_message_ids(
    connection: &Connection,
    chat_id: &str,
    recent: usize,
) -> AppResult<HashSet<String>> {
    let mut excluded = HashSet::new();
    if recent > 0 {
        let mut statement = connection.prepare(
            "SELECT id FROM messages WHERE chat_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let ids = statement.query_map(params![chat_id, recent as i64], |row| {
            row.get::<_, String>(0)
        })?;
        for id in ids {
            excluded.insert(id?);
        }
    }
    let latest_user: Option<String> = connection
        .query_row(
            "SELECT id FROM messages WHERE chat_id = ?1 AND LOWER(TRIM(role)) = 'user' ORDER BY created_at DESC, id DESC LIMIT 1",
            [chat_id],
            |row| row.get(0),
        )
        .optional()?;
    excluded.extend(latest_user);
    Ok(excluded)
}

pub(super) const CHAT_MEMORY_COLUMNS: &str =
    "chat_id, summary, facts_json, updated_at, summary_auto, summarized_through_message_id";

pub(super) fn map_chat_memory_row(row: &Row<'_>) -> rusqlite::Result<ChatMemoryRecord> {
    let facts_json: String = row.get(2)?;
    Ok(ChatMemoryRecord {
        chat_id: row.get(0)?,
        summary: row.get(1)?,
        summary_auto: row.get::<_, i64>(4)? != 0,
        summarized_through_message_id: row.get(5)?,
        facts: parse_facts_json_lossy(&facts_json),
        facts_json,
        updated_at: row.get(3)?,
    })
}

fn normalize_facts_json(facts_json: Option<&str>) -> AppResult<String> {
    let raw = facts_json.unwrap_or("[]").trim();
    if raw.is_empty() {
        return Ok("[]".to_string());
    }

    let facts = parse_facts_json(raw)?;
    serde_json::to_string(&facts)
        .map_err(|error| AppError::Validation(format!("invalid facts_json value: {error}")))
}

fn parse_facts_json(raw: &str) -> AppResult<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::Validation(format!("invalid facts_json value: {error}")))?;

    let facts = match value {
        serde_json::Value::Array(values) => {
            let mut facts = Vec::new();
            for value in values {
                match value {
                    serde_json::Value::String(fact) => facts.push(fact),
                    serde_json::Value::Number(number) => facts.push(number.to_string()),
                    serde_json::Value::Bool(boolean) => facts.push(boolean.to_string()),
                    _ => {}
                }
            }
            facts
        }
        serde_json::Value::String(value) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        serde_json::Value::Null => Vec::new(),
        _ => {
            return Err(AppError::Validation(
                "facts_json must be a JSON array or string".to_string(),
            ));
        }
    };

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for fact in facts {
        let clean_fact = fact.trim();
        if clean_fact.is_empty() {
            continue;
        }
        let fact_string = clean_fact.to_string();
        if seen.insert(fact_string.clone()) {
            normalized.push(fact_string);
        }
    }

    Ok(normalized)
}

fn parse_facts_json_lossy(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    parse_facts_json(trimmed).unwrap_or_default()
}

#[derive(Debug, Clone, Default)]
struct RetrievalHintsProfile {
    concise: bool,
    direct: bool,
    empathetic: bool,
    creative: bool,
    strategic: bool,
    playful: bool,
    formal: bool,
}

#[derive(Debug)]
struct MemoryCandidateDocument {
    rank: usize,
    candidate: MessageRecord,
    content_lower: String,
    term_set: HashSet<String>,
    ngrams: HashSet<String>,
}

struct MemoryScoreContext<'a> {
    query_lower: &'a str,
    query_term_weights: &'a HashMap<String, f64>,
    query_ngrams: &'a HashSet<String>,
    total_candidates: usize,
    preferred_speaker_id: Option<&'a str>,
    retrieval_profile: &'a RetrievalHintsProfile,
}

fn build_query_term_weights(
    query_unique_terms: &[String],
    candidate_docs: &[MemoryCandidateDocument],
    total_candidates: usize,
) -> HashMap<String, f64> {
    if query_unique_terms.is_empty() || candidate_docs.is_empty() {
        return HashMap::new();
    }

    let mut document_frequency = HashMap::new();
    for term in query_unique_terms {
        document_frequency.insert(term.clone(), 0_usize);
    }

    for candidate in candidate_docs {
        for term in query_unique_terms {
            if candidate.term_set.contains(term) {
                if let Some(count) = document_frequency.get_mut(term) {
                    *count += 1_usize;
                }
            }
        }
    }

    let denominator = total_candidates.max(1) as f64;
    let mut query_term_weights = HashMap::new();
    for term in query_unique_terms {
        let df = *document_frequency.get(term).unwrap_or(&0_usize) as f64;
        let idf_weight = ((denominator + 1.0_f64) / (df + 1.0_f64)).ln() + 1.0_f64;
        query_term_weights.insert(term.clone(), idf_weight);
    }

    query_term_weights
}

fn unique_terms(tokens: &[String]) -> Vec<String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for token in tokens {
        if seen.insert(token.clone()) {
            unique.push(token.clone());
        }
    }
    unique
}

fn score_memory_snippet(
    candidate: &MemoryCandidateDocument,
    context: &MemoryScoreContext<'_>,
) -> i64 {
    if candidate.content_lower.trim().is_empty() {
        return 0_i64;
    }

    let total_query_weight = context.query_term_weights.values().sum::<f64>();
    let mut matched_weight = 0.0_f64;
    let mut matched_terms = 0_usize;
    for (term, weight) in context.query_term_weights {
        if candidate.term_set.contains(term) {
            matched_weight += *weight;
            matched_terms += 1_usize;
        }
    }

    let weighted_overlap = if total_query_weight > 0.0_f64 {
        matched_weight / total_query_weight
    } else {
        0.0_f64
    };
    let overlap_ratio = if context.query_term_weights.is_empty() {
        0.0_f64
    } else {
        matched_terms as f64 / context.query_term_weights.len() as f64
    };
    let ngram_similarity = dice_similarity_score(context.query_ngrams, &candidate.ngrams);
    let phrase_match = if candidate.content_lower.contains(context.query_lower) {
        1.0_f64
    } else {
        0.0_f64
    };

    if matched_terms == 0_usize && ngram_similarity < 0.16_f64 && phrase_match == 0.0_f64 {
        return 0_i64;
    }

    let semantic_score =
        (weighted_overlap * 0.52_f64) + (ngram_similarity * 0.26_f64) + (overlap_ratio * 0.22_f64);
    let phrase_bonus = if phrase_match > 0.0_f64 {
        0.18_f64
    } else {
        0.0_f64
    };
    let recency_bonus = recency_rank_bonus(candidate.rank, context.total_candidates);
    let speaker_bonus = speaker_alignment_bonus(
        candidate.candidate.speaker_character_id.as_deref(),
        context.preferred_speaker_id,
    );
    let retrieval_bonus =
        retrieval_alignment_bonus(&candidate.content_lower, context.retrieval_profile);

    let raw_score = semantic_score + phrase_bonus + recency_bonus + speaker_bonus + retrieval_bonus;
    let score = (raw_score.clamp(0.0_f64, 1.85_f64) * 100.0_f64).round() as i64;
    if score < 18_i64 {
        0_i64
    } else {
        score
    }
}

fn recency_rank_bonus(rank: usize, total_candidates: usize) -> f64 {
    if total_candidates <= 1_usize {
        return 0.08_f64;
    }
    let bounded_rank = rank.min(total_candidates - 1_usize);
    let recency_ratio = 1.0_f64 - (bounded_rank as f64 / (total_candidates - 1_usize) as f64);
    0.12_f64 * recency_ratio
}

fn speaker_alignment_bonus(
    speaker_character_id: Option<&str>,
    preferred_speaker_id: Option<&str>,
) -> f64 {
    match (
        speaker_character_id
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        preferred_speaker_id
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(speaker), Some(preferred)) if speaker == preferred => 0.12_f64,
        _ => 0.0_f64,
    }
}

fn retrieval_alignment_bonus(content_lower: &str, hints: &RetrievalHintsProfile) -> f64 {
    if content_lower.trim().is_empty() {
        return 0.0_f64;
    }

    let mut bonus = 0.0_f64;
    let content_length = content_lower.chars().count();

    if hints.concise {
        if content_length <= 220_usize {
            bonus += 0.05_f64;
        } else if content_length >= 520_usize {
            bonus -= 0.04_f64;
        }
    }
    if hints.direct
        && (contains_any_phrase(
            content_lower,
            &["should", "need to", "must", "recommend", "best move"],
        ) || content_length <= 220_usize)
    {
        bonus += 0.03_f64;
    }
    if hints.empathetic
        && contains_any_phrase(
            content_lower,
            &[
                "i understand",
                "that sounds",
                "i hear you",
                "it's okay",
                "you deserve",
                "i am here",
            ],
        )
    {
        bonus += 0.07_f64;
    }
    if hints.creative
        && contains_any_phrase(
            content_lower,
            &[
                "imagine",
                "story",
                "metaphor",
                "what if",
                "creative",
                "brainstorm",
            ],
        )
    {
        bonus += 0.07_f64;
    }
    if hints.strategic
        && contains_any_phrase(
            content_lower,
            &[
                "step", "plan", "strategy", "tradeoff", "first", "second", "option",
            ],
        )
    {
        bonus += 0.07_f64;
    }
    if hints.playful
        && (contains_any_phrase(
            content_lower,
            &["fun", "play", "joke", "haha", "lol", "awesome"],
        ) || content_lower.contains('!'))
    {
        bonus += 0.04_f64;
    }
    if hints.formal
        && contains_any_phrase(
            content_lower,
            &[
                "therefore",
                "however",
                "in summary",
                "consider",
                "recommendation",
            ],
        )
    {
        bonus += 0.05_f64;
    }

    bonus.clamp(-0.08_f64, 0.16_f64)
}

fn derive_retrieval_hints_profile(retrieval_hints: &str) -> RetrievalHintsProfile {
    let prompt_lower = retrieval_hints.to_lowercase();
    if prompt_lower.trim().is_empty() {
        return RetrievalHintsProfile::default();
    }

    RetrievalHintsProfile {
        concise: contains_any_phrase(
            &prompt_lower,
            &[
                "concise",
                "brief",
                "succinct",
                "to the point",
                "short responses",
                "short answer",
            ],
        ),
        direct: contains_any_phrase(
            &prompt_lower,
            &[
                "direct",
                "straightforward",
                "no fluff",
                "blunt",
                "no-nonsense",
            ],
        ),
        empathetic: contains_any_phrase(
            &prompt_lower,
            &[
                "empathetic",
                "empathy",
                "warm",
                "kind",
                "supportive",
                "compassion",
                "gentle",
            ],
        ),
        creative: contains_any_phrase(
            &prompt_lower,
            &[
                "creative",
                "imaginative",
                "inventive",
                "story",
                "poetic",
                "brainstorm",
            ],
        ),
        strategic: contains_any_phrase(
            &prompt_lower,
            &[
                "strategic",
                "analytical",
                "reasoned",
                "step by step",
                "tradeoff",
                "plan",
                "decisive",
            ],
        ),
        playful: contains_any_phrase(
            &prompt_lower,
            &["playful", "fun", "humor", "witty", "lighthearted"],
        ),
        formal: contains_any_phrase(
            &prompt_lower,
            &["formal", "professional", "polished", "businesslike"],
        ),
    }
}

fn contains_any_phrase(haystack: &str, phrases: &[&str]) -> bool {
    phrases
        .iter()
        .filter_map(|phrase| {
            let clean_phrase = phrase.trim();
            if clean_phrase.is_empty() {
                None
            } else {
                Some(clean_phrase)
            }
        })
        .any(|phrase| haystack.contains(phrase))
}

pub(super) fn tokenize_similarity_terms(value: &str) -> Vec<String> {
    tokenize_similarity_terms_internal(value, false)
}

fn tokenize_similarity_terms_internal(value: &str, keep_stopwords: bool) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in value.split(|character: char| !character.is_alphanumeric()) {
        if let Some(normalized) = normalize_similarity_token(token, keep_stopwords) {
            tokens.push(normalized);
        }
    }

    if tokens.is_empty() && !keep_stopwords && !value.trim().is_empty() {
        return tokenize_similarity_terms_internal(value, true);
    }

    if tokens.is_empty() && keep_stopwords && !value.trim().is_empty() {
        tokens.push(value.trim().to_lowercase());
    }

    tokens
}

fn normalize_similarity_token(token: &str, keep_stopwords: bool) -> Option<String> {
    let clean_token = token.trim().to_lowercase();
    if clean_token.is_empty() {
        return None;
    }
    if clean_token.len() <= 1_usize {
        return None;
    }
    if !keep_stopwords && is_similarity_stopword(&clean_token) {
        return None;
    }
    Some(stem_similarity_token(&clean_token))
}

fn stem_similarity_token(token: &str) -> String {
    if token.len() <= 3_usize {
        return token.to_string();
    }

    if token.len() > 6_usize && token.ends_with("ingly") {
        return token.trim_end_matches("ingly").to_string();
    }
    if token.len() > 5_usize && token.ends_with("edly") {
        return token.trim_end_matches("edly").to_string();
    }
    if token.len() > 5_usize && token.ends_with("ing") {
        return token.trim_end_matches("ing").to_string();
    }
    if token.len() > 4_usize && token.ends_with("ed") {
        return token.trim_end_matches("ed").to_string();
    }
    if token.len() > 4_usize && token.ends_with("ly") {
        return token.trim_end_matches("ly").to_string();
    }
    if token.len() > 4_usize && token.ends_with("es") {
        return token.trim_end_matches("es").to_string();
    }
    if token.len() > 3_usize && token.ends_with('s') && !token.ends_with("ss") {
        return token.trim_end_matches('s').to_string();
    }

    token.to_string()
}

fn is_similarity_stopword(token: &str) -> bool {
    matches!(
        token,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "he"
            | "her"
            | "here"
            | "him"
            | "his"
            | "how"
            | "i"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "its"
            | "me"
            | "my"
            | "of"
            | "on"
            | "or"
            | "our"
            | "she"
            | "that"
            | "the"
            | "their"
            | "them"
            | "there"
            | "they"
            | "this"
            | "to"
            | "us"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "why"
            | "with"
            | "you"
            | "your"
    )
}

fn build_token_ngrams(tokens: &[String], n: usize) -> HashSet<String> {
    let mut ngrams = HashSet::new();
    if tokens.is_empty() {
        return ngrams;
    }

    let width = n.max(1);
    if tokens.len() < width {
        ngrams.extend(tokens.iter().cloned());
        return ngrams;
    }

    for window in tokens.windows(width) {
        ngrams.insert(window.join(" "));
    }

    ngrams
}

pub(super) fn dice_similarity_score(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0_f64;
    }

    let intersection = left.intersection(right).count() as f64;
    (2.0_f64 * intersection) / (left.len() as f64 + right.len() as f64)
}

pub(super) fn normalize_content_for_dedupe(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    let mut in_whitespace = false;

    for character in content.chars() {
        if character.is_whitespace() {
            if !in_whitespace {
                normalized.push(' ');
                in_whitespace = true;
            }
            continue;
        }

        in_whitespace = false;
        normalized.extend(character.to_lowercase());
    }

    normalized.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct Fixture {
        db: Database,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("glee-memory-test-{}", Uuid::new_v4()));
            let db = Database::new(root.join("test.sqlite3")).unwrap();
            Self { db, root }
        }

        fn append(&self, chat_id: &str, role: &str, content: &str) -> MessageRecord {
            self.db
                .append_message_at_epoch(chat_id, role, content, None, None)
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn recalled_ids(f: &Fixture, chat_id: &str, query: &str, exclude_recent: usize) -> Vec<String> {
        f.db.resolve_memory_snippets(chat_id, query, 12, None, None, exclude_recent)
            .unwrap()
            .into_iter()
            .map(|hit| hit.message_id)
            .collect()
    }

    #[test]
    fn lexical_recall_skips_the_recent_window() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        let old = f.append(
            &chat.id,
            "assistant",
            "The lighthouse keeper owns a brass telescope.",
        );
        let recent = f.append(
            &chat.id,
            "assistant",
            "The lighthouse keeper polishes the brass telescope.",
        );
        f.append(
            &chat.id,
            "user",
            "Does the lighthouse keeper still have that telescope?",
        );

        assert_eq!(
            recalled_ids(&f, &chat.id, "lighthouse keeper telescope", 2),
            vec![old.id.clone()]
        );
        let mut with_recent = recalled_ids(&f, &chat.id, "lighthouse keeper telescope", 0);
        with_recent.sort();
        let mut expected = vec![old.id, recent.id];
        expected.sort();
        assert_eq!(with_recent, expected);
    }

    #[test]
    fn lexical_recall_never_returns_the_latest_user_message() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        let earlier_user = f.append(&chat.id, "user", "My favorite tea is jasmine green tea.");
        let latest_user = f.append(&chat.id, "user", "Remind me, what is my favorite tea?");
        for index in 0..3 {
            f.append(
                &chat.id,
                "assistant",
                &format!("Filler reply number {index}."),
            );
        }

        // Even with the recency window disabled, the question itself is not recalled.
        let ids = recalled_ids(&f, &chat.id, "favorite tea", 0);
        assert!(ids.contains(&earlier_user.id));
        assert!(!ids.contains(&latest_user.id));
    }

    #[test]
    fn lexical_recall_uses_the_default_window_for_short_chats() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        for index in 0..Database::RECALL_EXCLUDED_RECENT_MESSAGES {
            f.append(
                &chat.id,
                "assistant",
                &format!("Harbor fact {index}: the harbor bell rings at dusk."),
            );
        }

        assert!(recalled_ids(
            &f,
            &chat.id,
            "harbor bell",
            Database::RECALL_EXCLUDED_RECENT_MESSAGES
        )
        .is_empty());
        f.append(
            &chat.id,
            "assistant",
            "Unrelated newer message about weather.",
        );
        assert_eq!(
            recalled_ids(
                &f,
                &chat.id,
                "harbor bell",
                Database::RECALL_EXCLUDED_RECENT_MESSAGES
            )
            .len(),
            1
        );
    }
}
