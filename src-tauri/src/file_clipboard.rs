use std::{path::PathBuf, sync::Mutex};

// 保持剪贴板实例存活，让 Linux 等需要应用持续提供数据的平台也能稍后粘贴。
#[derive(Default)]
pub(crate) struct FileClipboard(Mutex<Option<arboard::Clipboard>>);

#[derive(serde::Serialize)]
pub(crate) struct ClipboardTextFormats {
    html: String,
    text: String,
}

/// Read Excel's editable HTML representation before considering its alternate bitmap.
/// The WebView clipboard API can omit HTML or reject reads even when CF_HTML is present.
#[tauri::command]
pub(crate) fn read_editor_clipboard_text(
    state: tauri::State<'_, FileClipboard>,
) -> Result<ClipboardTextFormats, String> {
    let mut clipboard = state.0.lock().map_err(|error| error.to_string())?;
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new().map_err(|error| error.to_string())?);
    }
    let clipboard = clipboard.as_mut().ok_or("Clipboard is unavailable")?;
    Ok(ClipboardTextFormats {
        // An absent format is normal, e.g. when the user copied only a screenshot.
        html: clipboard.get().html().unwrap_or_default(),
        text: clipboard.get_text().unwrap_or_default(),
    })
}

/// 复制已保存的文件引用，供系统文件管理器及聊天软件粘贴为附件。
#[tauri::command]
pub(crate) fn copy_file_to_clipboard(
    path: String,
    state: tauri::State<'_, FileClipboard>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err("File does not exist or is not an absolute file path".into());
    }
    let mut clipboard = state.0.lock().map_err(|error| error.to_string())?;
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new().map_err(|error| error.to_string())?);
    }
    clipboard
        .as_mut()
        .ok_or("Clipboard is unavailable")?
        .set()
        .file_list(&[path])
        .map_err(|error| error.to_string())
}
