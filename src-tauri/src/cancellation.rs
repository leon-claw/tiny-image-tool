use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use tokio::sync::Notify;

#[derive(Default)]
pub struct CompressionCancelState {
    cancelled_runs: Mutex<HashSet<String>>,
    notify: Arc<Notify>,
}

impl CompressionCancelState {
    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        let mut cancelled = self
            .cancelled_runs
            .lock()
            .map_err(|_| "Could not lock compression cancellation state".to_string())?;
        cancelled.insert(run_id.to_string());
        self.notify.notify_waiters();
        Ok(())
    }

    pub fn clear(&self, run_id: &str) -> Result<(), String> {
        let mut cancelled = self
            .cancelled_runs
            .lock()
            .map_err(|_| "Could not lock compression cancellation state".to_string())?;
        cancelled.remove(run_id);
        Ok(())
    }

    pub fn is_cancelled(&self, run_id: &str) -> Result<bool, String> {
        let cancelled = self
            .cancelled_runs
            .lock()
            .map_err(|_| "Could not lock compression cancellation state".to_string())?;
        Ok(cancelled.contains(run_id))
    }

    pub async fn cancelled(&self, run_id: &str) -> Result<(), String> {
        loop {
            if self.is_cancelled(run_id)? {
                return Ok(());
            }
            self.notify.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_marks_run_as_cancelled() {
        let state = CompressionCancelState::default();

        state.cancel("run-1").unwrap();

        assert!(state.is_cancelled("run-1").unwrap());
        assert!(!state.is_cancelled("run-2").unwrap());
    }

    #[test]
    fn clear_removes_cancelled_run() {
        let state = CompressionCancelState::default();
        state.cancel("run-1").unwrap();

        state.clear("run-1").unwrap();

        assert!(!state.is_cancelled("run-1").unwrap());
    }
}
