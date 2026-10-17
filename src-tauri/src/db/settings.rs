use rusqlite::{OptionalExtension, Row};

use crate::errors::{AppError, AppResult};
use crate::types::{AppSettingRecord, RuntimeLaunchSettingsRecord, RuntimePerformanceMode};

use super::Database;

const RUNTIME_WARMUP_ENABLED_SETTING_KEY: &str = "runtime_warmup_enabled";
const RUNTIME_GPU_LAYERS_SETTING_KEY: &str = "runtime_gpu_layers";
const RUNTIME_PERFORMANCE_MODE_SETTING_KEY: &str = "runtime_performance_mode";
const DEFAULT_RUNTIME_WARMUP_ENABLED: bool = true;
const DEFAULT_RUNTIME_GPU_LAYERS: i64 = 0;
const DEFAULT_RUNTIME_PERFORMANCE_MODE: RuntimePerformanceMode = RuntimePerformanceMode::Auto;

impl Database {
    pub fn list_settings(&self) -> AppResult<Vec<AppSettingRecord>> {
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(
            "
            SELECT key, value, updated_at
            FROM app_settings
            ORDER BY key ASC
            ",
        )?;
        let rows = statement.query_map([], map_setting_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<AppSettingRecord>> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::Validation(
                "setting key cannot be empty".to_string(),
            ));
        }

        let connection = self.open_connection()?;
        connection
            .query_row(
                "
                SELECT key, value, updated_at
                FROM app_settings
                WHERE key = ?1
                LIMIT 1
                ",
                [key],
                map_setting_row,
            )
            .optional()
            .map_err(AppError::from)
    }

    pub fn set_runtime_launch_settings(
        &self,
        warmup_enabled: bool,
        gpu_layers: i64,
        performance_mode: RuntimePerformanceMode,
    ) -> AppResult<RuntimeLaunchSettingsRecord> {
        if gpu_layers < 0 {
            return Err(AppError::Validation(
                "runtime GPU layers must be greater than or equal to 0".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let now = super::now_rfc3339();

        let warmup_value = if warmup_enabled { "true" } else { "false" };
        let gpu_layers_value = gpu_layers.to_string();
        let performance_mode_value = serialize_performance_mode(performance_mode);
        super::upsert_setting_tx(
            &transaction,
            RUNTIME_WARMUP_ENABLED_SETTING_KEY,
            warmup_value,
            &now,
        )?;
        super::upsert_setting_tx(
            &transaction,
            RUNTIME_GPU_LAYERS_SETTING_KEY,
            &gpu_layers_value,
            &now,
        )?;
        super::upsert_setting_tx(
            &transaction,
            RUNTIME_PERFORMANCE_MODE_SETTING_KEY,
            performance_mode_value,
            &now,
        )?;
        transaction.commit()?;

        Ok(RuntimeLaunchSettingsRecord {
            warmup_enabled,
            gpu_layers,
            performance_mode,
            updated_at: now,
        })
    }

    pub fn get_runtime_launch_settings(&self) -> AppResult<RuntimeLaunchSettingsRecord> {
        let warmup_setting = self.get_setting(RUNTIME_WARMUP_ENABLED_SETTING_KEY)?;
        let gpu_layers_setting = self.get_setting(RUNTIME_GPU_LAYERS_SETTING_KEY)?;
        let performance_mode_setting = self.get_setting(RUNTIME_PERFORMANCE_MODE_SETTING_KEY)?;

        let warmup_enabled = parse_bool_setting(
            warmup_setting
                .as_ref()
                .map(|setting| setting.value.as_str()),
            DEFAULT_RUNTIME_WARMUP_ENABLED,
        );
        let gpu_layers = parse_nonnegative_i64_setting(
            gpu_layers_setting
                .as_ref()
                .map(|setting| setting.value.as_str()),
            DEFAULT_RUNTIME_GPU_LAYERS,
        );
        let performance_mode = parse_performance_mode_setting(
            performance_mode_setting
                .as_ref()
                .map(|setting| setting.value.as_str()),
            DEFAULT_RUNTIME_PERFORMANCE_MODE,
        );
        let updated_at = warmup_setting
            .as_ref()
            .map(|setting| setting.updated_at.clone())
            .into_iter()
            .chain(
                gpu_layers_setting
                    .as_ref()
                    .map(|setting| setting.updated_at.clone()),
            )
            .chain(
                performance_mode_setting
                    .as_ref()
                    .map(|setting| setting.updated_at.clone()),
            )
            .max()
            .unwrap_or_else(super::now_rfc3339);

        Ok(RuntimeLaunchSettingsRecord {
            warmup_enabled,
            gpu_layers,
            performance_mode,
            updated_at,
        })
    }
}

fn map_setting_row(row: &Row<'_>) -> rusqlite::Result<AppSettingRecord> {
    Ok(AppSettingRecord {
        key: row.get(0)?,
        value: row.get(1)?,
        updated_at: row.get(2)?,
    })
}

fn parse_bool_setting(value: Option<&str>, default: bool) -> bool {
    let Some(value) = value.map(str::trim) else {
        return default;
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

fn parse_nonnegative_i64_setting(value: Option<&str>, default: i64) -> i64 {
    let Some(value) = value.map(str::trim) else {
        return default;
    };
    match value.parse::<i64>() {
        Ok(parsed) if parsed >= 0 => parsed,
        _ => default,
    }
}

fn parse_performance_mode_setting(
    value: Option<&str>,
    default: RuntimePerformanceMode,
) -> RuntimePerformanceMode {
    let Some(value) = value.map(str::trim) else {
        return default;
    };
    match value.to_ascii_lowercase().as_str() {
        "auto" => RuntimePerformanceMode::Auto,
        "cpu" | "cpu_only" | "safe" => RuntimePerformanceMode::Cpu,
        "gpu" | "gpu_preferred" => RuntimePerformanceMode::Gpu,
        _ => default,
    }
}

fn serialize_performance_mode(mode: RuntimePerformanceMode) -> &'static str {
    match mode {
        RuntimePerformanceMode::Auto => "auto",
        RuntimePerformanceMode::Cpu => "cpu",
        RuntimePerformanceMode::Gpu => "gpu",
    }
}
