//! Instance-scoped admission and cancellation for media background work.
//! A lease stays counted until even a non-interruptible blocking worker exits.
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

#[derive(Clone)]
pub struct BackgroundWork(Arc<Inner>);
struct Inner {
    state: Mutex<State>,
    changed: watch::Sender<u64>,
}
#[derive(Default)]
struct State {
    standby: bool,
    generation: u64,
    pending: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BackgroundStatus {
    pub standby: bool,
    pub pending: usize,
    pub quiescent: bool,
}

impl Default for BackgroundWork {
    fn default() -> Self {
        let (changed, _) = watch::channel(0);
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed,
        }))
    }
}
impl BackgroundWork {
    pub fn status(&self) -> BackgroundStatus {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        BackgroundStatus {
            standby: state.standby,
            pending: state.pending,
            quiescent: state.standby && state.pending == 0,
        }
    }
    pub fn set_standby(&self, standby: bool) -> BackgroundStatus {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.standby != standby {
            state.standby = standby;
            state.generation += 1;
            self.0.changed.send_replace(state.generation);
        }
        BackgroundStatus {
            standby,
            pending: state.pending,
            quiescent: standby && state.pending == 0,
        }
    }
    pub fn enter(&self) -> Result<WorkLease, &'static str> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.standby {
            return Err("Player is in standby");
        }
        state.pending += 1;
        Ok(WorkLease(Arc::new(Lease {
            work: self.clone(),
            generation: state.generation,
        })))
    }
}

#[derive(Clone)]
pub struct WorkLease(Arc<Lease>);
struct Lease {
    work: BackgroundWork,
    generation: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.work
            .0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending -= 1;
    }
}
impl WorkLease {
    /// Serialize a short in-memory publication with the standby transition.
    pub fn publish<T>(&self, publish: impl FnOnce() -> T) -> Result<T, &'static str> {
        let state = self
            .0
            .work
            .0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.standby || state.generation != self.0.generation {
            return Err("Player background work cancelled");
        }
        Ok(publish())
    }
    pub fn check(&self) -> Result<(), &'static str> {
        let state = self
            .0
            .work
            .0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.standby || state.generation != self.0.generation {
            Err("Player background work cancelled")
        } else {
            Ok(())
        }
    }
    pub async fn cancelled(&self) {
        let mut changed = self.0.work.0.changed.subscribe();
        while self.check().is_ok() {
            if changed.changed().await.is_err() {
                break;
            }
        }
    }
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> Result<T, &'static str> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.cancelled() => Err("Player background work cancelled"),
            value = future => { self.check()?; Ok(value) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stop_revokes_old_generation_even_after_wake() {
        let work = BackgroundWork::default();
        let old = work.enter().unwrap();
        assert_eq!(work.set_standby(true).pending, 1);
        assert!(work.enter().is_err());
        work.set_standby(false);
        assert!(old.run(async { 1 }).await.is_err());
        assert_eq!(work.enter().unwrap().run(async { 2 }).await.unwrap(), 2);
        drop(old);
        assert!(work.set_standby(true).quiescent);
    }
    #[tokio::test]
    async fn cancellation_drops_network_future_but_counts_blocking_owner() {
        let work = BackgroundWork::default();
        let lease = work.enter().unwrap();
        let blocking = lease.clone();
        let task = tokio::spawn(async move { lease.run(std::future::pending::<()>()).await });
        work.set_standby(true);
        assert!(task.await.unwrap().is_err());
        assert!(!work.status().quiescent);
        assert_eq!(work.status().pending, 1);
        drop(blocking);
        assert!(work.status().quiescent);
    }
}
