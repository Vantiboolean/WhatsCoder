//! Polls every **15 seconds** for automations whose `next_run_at` has passed and `status` is `ACTIVE`, then emits `automation://due`.
//! Unfocused windows may get a desktop notification when `background_notify` is set; the interval balances responsiveness and idle cost.

use std::{
    collections::HashMap,
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSchedulerEntry {
    pub id: String,
    pub name: String,
    pub status: String,
    pub next_run_at: Option<i64>,
    pub background_notify: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDueEvent {
    id: String,
    next_run_at: i64,
}

#[derive(Debug, Clone)]
struct SchedulerRuntimeEntry {
    entry: AutomationSchedulerEntry,
    last_emitted_next_run_at: Option<i64>,
}

/// Shared map of automation id → last-synced row plus `last_emitted_next_run_at` to avoid re-emitting
/// the same due timestamp after the frontend refreshes without advancing the schedule.
#[derive(Default)]
pub struct AutomationSchedulerState(Mutex<HashMap<String, SchedulerRuntimeEntry>>);

fn now_unix_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// Replaces the in-memory schedule from the UI; carries over dedupe state only when `next_run_at` and `status` are unchanged.
#[tauri::command]
pub fn sync_automation_scheduler(
    app: AppHandle,
    entries: Vec<AutomationSchedulerEntry>,
) -> Result<(), String> {
    let state = app.state::<AutomationSchedulerState>();
    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("Automation scheduler lock error: {err}"))?;

    let mut next_entries = HashMap::new();
    for entry in entries {
        let last_emitted_next_run_at = guard.get(&entry.id).and_then(|existing| {
            if existing.entry.next_run_at == entry.next_run_at
                && existing.entry.status == entry.status
            {
                existing.last_emitted_next_run_at
            } else {
                None
            }
        });

        next_entries.insert(
            entry.id.clone(),
            SchedulerRuntimeEntry {
                entry,
                last_emitted_next_run_at,
            },
        );
    }

    *guard = next_entries;
    Ok(())
}

/// Runs on a blocking thread (not the async runtime) so polling never starves UI work; backs off on mutex poison.
pub fn start_background_scheduler<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn_blocking(move || loop {
        let due_entries = {
            let state = app.state::<AutomationSchedulerState>();
            let mut guard = match state.0.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    thread::sleep(Duration::from_secs(15));
                    continue;
                }
            };

            let now = now_unix_sec();
            let mut due = Vec::new();

            for runtime_entry in guard.values_mut() {
                let Some(next_run_at) = runtime_entry.entry.next_run_at else {
                    continue;
                };

                if runtime_entry.entry.status != "ACTIVE" || next_run_at > now {
                    continue;
                }

                if runtime_entry.last_emitted_next_run_at == Some(next_run_at) {
                    continue;
                }

                runtime_entry.last_emitted_next_run_at = Some(next_run_at);
                due.push(runtime_entry.entry.clone());
            }

            due
        };

        if !due_entries.is_empty() {
            let focused = app
                .get_webview_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);

            for entry in due_entries {
                if entry.background_notify && !focused {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Automation due")
                        .body(format!("{} is ready to run.", entry.name))
                        .show();
                }

                let _ = app.emit(
                    "automation://due",
                    AutomationDueEvent {
                        id: entry.id,
                        next_run_at: entry.next_run_at.unwrap_or_default(),
                    },
                );
            }
        }

        thread::sleep(Duration::from_secs(15));
    });
}
