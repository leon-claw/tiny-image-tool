use std::sync::Mutex;

#[derive(Default)]
pub struct PowerAssertionState {
    assertion: Mutex<Option<PowerAssertion>>,
}

#[tauri::command]
pub fn begin_power_assertion(state: tauri::State<'_, PowerAssertionState>) -> Result<(), String> {
    let mut guard = state
        .assertion
        .lock()
        .map_err(|_| "Could not lock power assertion".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    *guard = Some(PowerAssertion::begin()?);
    Ok(())
}

#[tauri::command]
pub fn end_power_assertion(state: tauri::State<'_, PowerAssertionState>) -> Result<(), String> {
    let mut guard = state
        .assertion
        .lock()
        .map_err(|_| "Could not lock power assertion".to_string())?;
    *guard = None;
    Ok(())
}

impl Drop for PowerAssertionState {
    fn drop(&mut self) {
        if let Ok(mut assertion) = self.assertion.lock() {
            *assertion = None;
        }
    }
}

enum PowerAssertion {
    #[cfg(target_os = "macos")]
    Macos(std::process::Child),
    #[cfg(target_os = "windows")]
    Windows,
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Noop,
}

impl PowerAssertion {
    fn begin() -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            let child = std::process::Command::new("caffeinate")
                .args(["-d", "-i", "-m", "-u"])
                .spawn()
                .map_err(|error| format!("Could not keep macOS awake: {error}"))?;
            Ok(Self::Macos(child))
        }

        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
            };

            let result = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            };
            if result == 0 {
                Err("Could not keep Windows awake".to_string())
            } else {
                Ok(Self::Windows)
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Ok(Self::Noop)
        }
    }
}

impl Drop for PowerAssertion {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let Self::Macos(child) = self;
            let _ = child.kill();
            let _ = child.wait();
        }

        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            let _ = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}
