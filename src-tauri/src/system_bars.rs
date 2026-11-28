use tauri::{AppHandle, Manager};

struct SystemBars(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("hub-system-bars")
        .setup(|app, api| {
            app.manage(SystemBars(api.register_android_plugin("local.hub.mobile", "SystemBars")?));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn set_system_bar_color(app: AppHandle, color: String) -> Result<(), String> {
    app.state::<SystemBars>()
        .0
        .run_mobile_plugin_async("setColor", serde_json::json!({ "color": color }))
        .await
        .map_err(|error| error.to_string())
}
