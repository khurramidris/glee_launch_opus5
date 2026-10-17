use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crc32fast::Hasher as Crc32Hasher;
use serde_json::{json, Map, Value};

use crate::{
    errors::{AppError, AppResult},
    types::CharacterRecord,
};

#[derive(Debug, Clone)]
pub struct ImportedCharacterCard {
    pub name: String,
    pub description: String,
    pub personality: String,
    pub backstory: String,
    pub scenario: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub speech_style: String,
    pub greeting: String,
    pub avatar: String,
    pub tags_json: String,
    pub likes_json: String,
    pub dislikes_json: String,
    pub alternate_greetings_json: String,
    pub boundaries: String,
    pub creator_notes: String,
    pub creator: String,
    pub character_version: String,
    pub card_extensions_json: String,
    pub card_passthrough_json: String,
    pub example_dialogue: String,
}

pub fn map_character_card_value(
    value: &Value,
    fallback_name: &str,
    fallback_avatar: Option<String>,
) -> AppResult<ImportedCharacterCard> {
    if !value.is_object() {
        return Err(AppError::Validation(
            "character card JSON must be an object".to_string(),
        ));
    }
    let data = value.get("data").unwrap_or(&Value::Null);

    let name = pick_card_string(data, &["name", "char_name"])
        .or_else(|| pick_card_string(value, &["name", "char_name"]))
        .unwrap_or_else(|| fallback_name.to_string());

    let description = pick_card_string(data, &["description"])
        .or_else(|| pick_card_string(value, &["description"]))
        .unwrap_or_default();
    let personality = pick_card_string(data, &["personality", "char_persona", "persona"])
        .or_else(|| pick_card_string(value, &["personality", "char_persona", "persona"]))
        .unwrap_or_default();
    let scenario = pick_card_string(data, &["scenario", "world_scenario"])
        .or_else(|| pick_card_string(value, &["scenario", "world_scenario"]))
        .unwrap_or_default();
    let system_prompt = pick_card_string(data, &["system_prompt", "system"])
        .or_else(|| pick_card_string(value, &["system_prompt", "system"]))
        .unwrap_or_default();
    let greeting = pick_card_string(data, &["first_mes", "first_message", "greeting"])
        .or_else(|| pick_card_string(value, &["first_mes", "first_message", "greeting"]))
        .unwrap_or_default();
    let example_dialogue = pick_card_string(data, &["mes_example", "example_dialogue"])
        .or_else(|| pick_card_string(value, &["mes_example", "example_dialogue"]))
        .unwrap_or_default();
    let creator_notes = pick_card_string(data, &["creator_notes"])
        .or_else(|| pick_card_string(value, &["creator_notes"]))
        .unwrap_or_default();
    let post_history_instructions = pick_card_string(data, &["post_history_instructions"])
        .or_else(|| pick_card_string(value, &["post_history_instructions"]))
        .unwrap_or_default();
    let creator = pick_card_string(data, &["creator"])
        .or_else(|| pick_card_string(value, &["creator"]))
        .unwrap_or_default();
    let character_version = pick_card_string(data, &["character_version"])
        .or_else(|| pick_card_string(value, &["character_version"]))
        .unwrap_or_default();
    let avatar = pick_card_string(data, &["avatar", "image"])
        .or_else(|| pick_card_string(value, &["avatar", "image"]))
        .or(fallback_avatar)
        .unwrap_or_default();
    let alternate_greetings = pick_card_tags(data, &["alternate_greetings"])
        .or_else(|| pick_card_tags(value, &["alternate_greetings"]))
        .unwrap_or_default();
    let alternate_greetings_json =
        serde_json::to_string(&alternate_greetings).map_err(|error| {
            AppError::Validation(format!(
                "failed to serialize alternate greetings into JSON: {error}"
            ))
        })?;

    let tags = pick_card_tags(data, &["tags"])
        .or_else(|| pick_card_tags(value, &["tags"]))
        .unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|error| {
        AppError::Validation(format!(
            "failed to serialize card tags into tags_json: {error}"
        ))
    })?;
    let extensions = pick_card_object(data, &["extensions"])
        .or_else(|| pick_card_object(value, &["extensions"]))
        .unwrap_or_default();
    let card_extensions_json = serde_json::to_string(&extensions).map_err(|error| {
        AppError::Validation(format!(
            "failed to serialize card extensions into JSON: {error}"
        ))
    })?;
    let glee_extension = extensions.get("glee").unwrap_or(&Value::Null);
    let backstory = pick_card_string(glee_extension, &["backstory"]).unwrap_or_default();
    let speech_style = pick_card_string(glee_extension, &["speech_style"]).unwrap_or_default();
    let likes = pick_card_tags(glee_extension, &["likes"]).unwrap_or_default();
    let dislikes = pick_card_tags(glee_extension, &["dislikes"]).unwrap_or_default();
    let boundaries = pick_card_string(glee_extension, &["boundaries"]).unwrap_or_default();
    let likes_json = serde_json::to_string(&likes).map_err(|error| {
        AppError::Validation(format!("failed to serialize card likes into JSON: {error}"))
    })?;
    let dislikes_json = serde_json::to_string(&dislikes).map_err(|error| {
        AppError::Validation(format!(
            "failed to serialize card dislikes into JSON: {error}"
        ))
    })?;
    let card_passthrough_json = serde_json::to_string(value).map_err(|error| {
        AppError::Validation(format!("failed to preserve character card JSON: {error}"))
    })?;

    let normalized_name = normalize_non_empty_or_default(name, fallback_name);

    Ok(ImportedCharacterCard {
        name: normalized_name.clone(),
        description: normalize_imported_card_text(description),
        personality: normalize_imported_card_text(personality),
        backstory: normalize_imported_card_text(backstory),
        scenario: normalize_imported_card_text(scenario),
        system_prompt: normalize_imported_card_text(system_prompt),
        post_history_instructions: normalize_imported_card_text(post_history_instructions),
        speech_style: normalize_imported_card_text(speech_style),
        greeting: normalize_imported_card_text(greeting),
        avatar,
        tags_json,
        likes_json,
        dislikes_json,
        alternate_greetings_json,
        boundaries: normalize_imported_card_text(boundaries),
        creator_notes: normalize_imported_card_text(creator_notes),
        creator: normalize_imported_card_text(creator),
        character_version: normalize_imported_card_text(character_version),
        card_extensions_json,
        card_passthrough_json,
        example_dialogue: normalize_imported_card_text(example_dialogue),
    })
}

pub fn build_character_card_json(character: &CharacterRecord) -> AppResult<Value> {
    let mut root = parse_passthrough_object(&character.card_passthrough_json)?;
    let spec = root
        .get("spec")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("chara_card_v2")
        .to_string();
    root.insert("spec".to_string(), Value::String(spec.clone()));
    let has_spec_version = root
        .get("spec_version")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if !has_spec_version {
        let default_version = if spec == "chara_card_v3" {
            "3.0"
        } else {
            "2.0"
        };
        root.insert(
            "spec_version".to_string(),
            Value::String(default_version.to_string()),
        );
    }

    let mut data = root
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut extensions = parse_extensions_object(&character.card_extensions_json)?;
    let mut glee_extension = extensions
        .remove("glee")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    glee_extension.remove("avatar_path");
    glee_extension.insert("backstory".to_string(), json!(character.backstory));
    glee_extension.insert("speech_style".to_string(), json!(character.speech_style));
    glee_extension.insert("likes".to_string(), json!(character.likes));
    glee_extension.insert("dislikes".to_string(), json!(character.dislikes));
    glee_extension.insert("boundaries".to_string(), json!(character.boundaries));
    extensions.insert("glee".to_string(), Value::Object(glee_extension));

    data.insert("name".to_string(), json!(character.name));
    data.insert("description".to_string(), json!(character.description));
    data.insert("personality".to_string(), json!(character.personality));
    data.insert("scenario".to_string(), json!(character.scenario));
    data.insert("first_mes".to_string(), json!(character.greeting));
    data.insert("mes_example".to_string(), json!(character.example_dialogue));
    data.insert("creator_notes".to_string(), json!(character.creator_notes));
    data.insert("system_prompt".to_string(), json!(character.system_prompt));
    data.insert(
        "post_history_instructions".to_string(),
        json!(character.post_history_instructions),
    );
    data.insert(
        "alternate_greetings".to_string(),
        json!(character.alternate_greetings),
    );
    data.insert("tags".to_string(), json!(character.tags));
    data.insert("creator".to_string(), json!(character.creator));
    data.insert(
        "character_version".to_string(),
        json!(character.character_version),
    );
    data.insert("extensions".to_string(), Value::Object(extensions));
    root.insert("data".to_string(), Value::Object(data));

    let mut payload = Value::Object(root);
    remove_avatar_path_fields(&mut payload);
    Ok(payload)
}

pub fn build_png_card_bytes(source_png: &[u8], character: &CharacterRecord) -> AppResult<Vec<u8>> {
    if !is_png_file_bytes(source_png) {
        return Err(AppError::Validation(
            "character portrait PNG data is invalid".to_string(),
        ));
    }

    let payload = build_character_card_json(character)?;
    let payload_json = serde_json::to_vec(&payload).map_err(|error| {
        AppError::Validation(format!("failed to serialize PNG card payload: {error}"))
    })?;
    let metadata_keyword = if payload.get("spec").and_then(Value::as_str) == Some("chara_card_v3") {
        "ccv3"
    } else {
        "chara"
    };
    let card_chunk = build_card_text_chunk(metadata_keyword, &BASE64_STANDARD.encode(payload_json));

    let mut output = Vec::with_capacity(source_png.len() + card_chunk.len() + 64);
    output.extend_from_slice(&source_png[..8]);

    let mut cursor = 8_usize;
    while cursor + 8 <= source_png.len() {
        let length = u32::from_be_bytes([
            source_png[cursor],
            source_png[cursor + 1],
            source_png[cursor + 2],
            source_png[cursor + 3],
        ]) as usize;
        let chunk_type = &source_png[cursor + 4..cursor + 8];
        let chunk_start = cursor;
        cursor += 8;

        if cursor + length + 4 > source_png.len() {
            return Err(AppError::Validation(
                "PNG chunk length is invalid".to_string(),
            ));
        }

        let chunk_data = &source_png[cursor..cursor + length];
        cursor += length + 4;

        if is_character_card_metadata_chunk(chunk_type, chunk_data)? {
            continue;
        }

        if chunk_type == b"IEND" {
            output.extend_from_slice(&card_chunk);
        }

        output.extend_from_slice(&source_png[chunk_start..cursor]);

        if chunk_type == b"IEND" {
            return Ok(output);
        }
    }

    Err(AppError::Validation(
        "PNG card is missing the IEND chunk".to_string(),
    ))
}

fn parse_extensions_object(raw: &str) -> AppResult<Map<String, Value>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let decoded: Value = serde_json::from_str(trimmed)
        .map_err(|error| AppError::Validation(format!("invalid card extensions JSON: {error}")))?;
    match decoded {
        Value::Object(object) => Ok(object),
        Value::Null => Ok(Map::new()),
        _ => Err(AppError::Validation(
            "card extensions JSON must be an object".to_string(),
        )),
    }
}

fn parse_passthrough_object(raw: &str) -> AppResult<Map<String, Value>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let decoded: Value = serde_json::from_str(trimmed).map_err(|error| {
        AppError::Validation(format!("invalid preserved character card JSON: {error}"))
    })?;
    match decoded {
        Value::Object(object) => Ok(object),
        Value::Null => Ok(Map::new()),
        _ => Err(AppError::Validation(
            "preserved character card JSON must be an object".to_string(),
        )),
    }
}

fn remove_avatar_path_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("avatar_path");
            for nested in object.values_mut() {
                remove_avatar_path_fields(nested);
            }
        }
        Value::Array(values) => {
            for nested in values {
                remove_avatar_path_fields(nested);
            }
        }
        _ => {}
    }
}

fn is_png_file_bytes(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    bytes.len() >= PNG_SIGNATURE.len() && bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
}

fn is_character_card_metadata_chunk(chunk_type: &[u8], chunk_data: &[u8]) -> AppResult<bool> {
    if chunk_type == b"tEXt" {
        return Ok(matches!(
            parse_png_text_keyword(chunk_data)?,
            Some("chara" | "ccv3")
        ));
    }
    if chunk_type == b"iTXt" {
        return Ok(matches!(
            parse_png_itxt_keyword(chunk_data)?,
            Some("chara" | "ccv3")
        ));
    }
    Ok(false)
}

fn build_card_text_chunk(keyword: &str, payload: &str) -> Vec<u8> {
    let mut chunk_data = Vec::with_capacity(keyword.len() + 1 + payload.len());
    chunk_data.extend_from_slice(keyword.as_bytes());
    chunk_data.push(0);
    chunk_data.extend_from_slice(payload.as_bytes());
    build_png_chunk(*b"tEXt", &chunk_data)
}

fn build_png_chunk(chunk_type: [u8; 4], chunk_data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(chunk_data.len() + 12);
    chunk.extend_from_slice(&(chunk_data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(&chunk_type);
    chunk.extend_from_slice(chunk_data);

    let mut hasher = Crc32Hasher::new();
    hasher.update(&chunk_type);
    hasher.update(chunk_data);
    chunk.extend_from_slice(&hasher.finalize().to_be_bytes());
    chunk
}

fn parse_png_text_keyword(chunk_data: &[u8]) -> AppResult<Option<&str>> {
    let keyword_end = if let Some(index) = chunk_data.iter().position(|byte| *byte == 0) {
        index
    } else {
        return Ok(None);
    };
    let keyword = std::str::from_utf8(&chunk_data[..keyword_end]).map_err(|error| {
        AppError::Validation(format!(
            "invalid tEXt chunk keyword in PNG metadata: {error}"
        ))
    })?;
    Ok(Some(keyword))
}

fn parse_png_itxt_keyword(chunk_data: &[u8]) -> AppResult<Option<&str>> {
    let keyword_end = if let Some(index) = chunk_data.iter().position(|byte| *byte == 0) {
        index
    } else {
        return Ok(None);
    };
    let keyword = std::str::from_utf8(&chunk_data[..keyword_end]).map_err(|error| {
        AppError::Validation(format!(
            "invalid iTXt chunk keyword in PNG metadata: {error}"
        ))
    })?;
    Ok(Some(keyword))
}

fn pick_card_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(raw) = value.get(*key).and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn pick_card_tags(value: &Value, keys: &[&str]) -> Option<Vec<String>> {
    for key in keys {
        if let Some(raw) = value.get(*key) {
            match raw {
                Value::Array(values) => {
                    let tags = normalize_string_values(
                        values
                            .iter()
                            .filter_map(|item| match item {
                                Value::String(tag) => Some(tag.clone()),
                                Value::Number(number) => Some(number.to_string()),
                                Value::Bool(boolean) => Some(boolean.to_string()),
                                _ => None,
                            })
                            .collect(),
                    );
                    return Some(tags);
                }
                Value::String(raw_tags) => {
                    let tags = normalize_string_values(
                        raw_tags
                            .split(',')
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToOwned::to_owned)
                            .collect(),
                    );
                    return Some(tags);
                }
                _ => {}
            }
        }
    }
    None
}

fn pick_card_object(value: &Value, keys: &[&str]) -> Option<Map<String, Value>> {
    for key in keys {
        if let Some(Value::Object(object)) = value.get(*key) {
            return Some(object.clone());
        }
    }
    None
}

fn normalize_non_empty_or_default(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_string_values(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

fn normalize_imported_card_text(value: String) -> String {
    value.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_character() -> CharacterRecord {
        CharacterRecord {
            id: "char-1".to_string(),
            name: "Nia".to_string(),
            description: "Launch operations analyst".to_string(),
            personality: "Warm and methodical".to_string(),
            backstory: "Former flight controller".to_string(),
            scenario: "you meet Nia in the launch bay".to_string(),
            system_prompt: "Stay in character.".to_string(),
            post_history_instructions: "Write Nia's next reply only.".to_string(),
            speech_style: "Measured and precise".to_string(),
            greeting: "Nia: Ready for review?".to_string(),
            alternate_greetings_json: "[\"Nia: You made it.\"]".to_string(),
            alternate_greetings: vec!["Nia: You made it.".to_string()],
            avatar: "D:/Cards/nia.png".to_string(),
            tags_json: "[\"ops\"]".to_string(),
            tags: vec!["ops".to_string()],
            likes_json: "[\"clarity\"]".to_string(),
            likes: vec!["clarity".to_string()],
            dislikes_json: "[\"chaos\"]".to_string(),
            dislikes: vec!["chaos".to_string()],
            boundaries: "Avoid gore.".to_string(),
            creator_notes: "Internal note".to_string(),
            creator: "Glee".to_string(),
            character_version: "1.2".to_string(),
            card_extensions_json:
                "{\"risu\":{\"foo\":1},\"glee\":{\"custom_flag\":true,\"avatar_path\":\"C:/private/nia.png\"}}"
                    .to_string(),
            card_passthrough_json: "{\"spec\":\"chara_card_v2\",\"spec_version\":\"2.0\",\"future_root\":{\"keep\":true},\"avatar_path\":\"C:/private/root.png\",\"data\":{\"character_book\":{\"entries\":[{\"keys\":[\"launch\"],\"content\":\"Keep this lore.\"}]}}}".to_string(),
            example_dialogue: "User: Status?\nNia: Green.".to_string(),
            created_at: "".to_string(),
            updated_at: "".to_string(),
        }
    }

    #[test]
    fn exports_v2_payload_with_preserved_extensions_and_glee_extension() {
        let payload =
            build_character_card_json(&fixture_character()).expect("payload should build");
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .expect("data");
        assert_eq!(data.get("name").and_then(Value::as_str), Some("Nia"));
        assert_eq!(
            data.get("personality").and_then(Value::as_str),
            Some("Warm and methodical")
        );
        let extensions = data
            .get("extensions")
            .and_then(Value::as_object)
            .expect("extensions");
        assert!(extensions.contains_key("risu"));
        let glee = extensions
            .get("glee")
            .and_then(Value::as_object)
            .expect("glee");
        assert_eq!(
            glee.get("backstory").and_then(Value::as_str),
            Some("Former flight controller")
        );
        assert_eq!(glee.get("custom_flag").and_then(Value::as_bool), Some(true));
        assert!(!glee.contains_key("avatar_path"));
        assert!(data.get("character_book").is_some());
        assert_eq!(
            payload
                .pointer("/future_root/keep")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(payload.get("avatar_path").is_none());
    }

    #[test]
    fn imports_v3_without_expanding_macros_and_round_trips_unknown_fields() {
        let source = json!({
            "spec": "chara_card_v3",
            "spec_version": "3.0",
            "future_root": {"keep": "yes"},
            "data": {
                "name": "Mara",
                "description": "{{char}} waits for {{user}}.",
                "personality": "Never replace {{char}} or {{user}} during import.",
                "first_mes": "Hello, {{user}}.",
                "nickname": "Mars",
                "assets": [{"type": "icon", "uri": "embeded://portrait.png", "name": "main", "ext": "png"}],
                "character_book": {"entries": [{"keys": ["harbor"], "content": "Unknown lore survives."}]},
                "extensions": {
                    "glee": {
                        "backstory": "A harbor pilot.",
                        "speech_style": "Dry and direct.",
                        "likes": ["storms"],
                        "dislikes": ["small talk"],
                        "boundaries": "No gore.",
                        "custom_flag": true,
                        "avatar_path": "C:/private/mara.png"
                    },
                    "future_extension": {"enabled": true}
                }
            }
        });

        let imported =
            map_character_card_value(&source, "fallback", None).expect("v3 card should import");
        assert_eq!(imported.description, "{{char}} waits for {{user}}.");
        assert_eq!(imported.greeting, "Hello, {{user}}.");
        assert_eq!(imported.backstory, "A harbor pilot.");
        assert_eq!(imported.speech_style, "Dry and direct.");
        assert_eq!(imported.likes_json, "[\"storms\"]");
        assert_eq!(imported.dislikes_json, "[\"small talk\"]");
        assert_eq!(imported.boundaries, "No gore.");

        let mut character = fixture_character();
        character.name = imported.name;
        character.description = imported.description;
        character.personality = imported.personality;
        character.backstory = imported.backstory;
        character.speech_style = imported.speech_style;
        character.greeting = imported.greeting;
        character.likes_json = imported.likes_json;
        character.likes = vec!["storms".to_string()];
        character.dislikes_json = imported.dislikes_json;
        character.dislikes = vec!["small talk".to_string()];
        character.boundaries = imported.boundaries;
        character.card_extensions_json = imported.card_extensions_json;
        character.card_passthrough_json = imported.card_passthrough_json;

        let exported = build_character_card_json(&character).expect("v3 card should export");
        assert_eq!(
            exported.get("spec").and_then(Value::as_str),
            Some("chara_card_v3")
        );
        assert_eq!(
            exported.pointer("/data/nickname").and_then(Value::as_str),
            Some("Mars")
        );
        assert!(exported.pointer("/data/assets/0").is_some());
        assert!(exported.pointer("/data/character_book/entries/0").is_some());
        assert_eq!(
            exported
                .pointer("/data/extensions/glee/custom_flag")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(exported
            .pointer("/data/extensions/glee/avatar_path")
            .is_none());
        assert_eq!(
            exported
                .pointer("/data/description")
                .and_then(Value::as_str),
            Some("{{char}} waits for {{user}}.")
        );
    }

    #[test]
    fn embeds_chara_metadata_into_png_output() {
        let png = BASE64_STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4R8AAAAASUVORK5CYII=")
            .expect("fixture png should decode");
        let encoded =
            build_png_card_bytes(&png, &fixture_character()).expect("png export should work");
        assert!(encoded.windows(5).any(|window| window == b"chara"));
    }

    #[test]
    fn embeds_ccv3_metadata_for_v3_png_output() {
        let png = BASE64_STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4R8AAAAASUVORK5CYII=")
            .expect("fixture png should decode");
        let mut character = fixture_character();
        character.card_passthrough_json =
            "{\"spec\":\"chara_card_v3\",\"spec_version\":\"3.0\",\"data\":{}}".to_string();
        let encoded = build_png_card_bytes(&png, &character).expect("v3 png export should work");
        assert!(encoded.windows(4).any(|window| window == b"ccv3"));
        assert!(!encoded.windows(6).any(|window| window == b"chara\0"));
    }
}
