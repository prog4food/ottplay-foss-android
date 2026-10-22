//! VM/type boundary only. All guide rules are compiled from the shared Kotlin core.
//! QuickJS has no network, filesystem, modules or application callbacks installed.
use rquickjs::function::{Constructor, This};
use rquickjs::{Context, Ctx, FromJs, Function, Object, Runtime};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const CORE: &str = include_str!("../../../vendor/ottplay-core.js");

#[derive(Clone)]
pub struct GuideIndex(
    Context,
    Option<Arc<AliasNames>>,
    Option<Arc<GuideInterrupt>>,
);

/// A caller-owned wall-clock budget; dropping an HTTP request cancels its work.
/// Only the hosted web adapter opts into it. It never changes matching rules.
#[derive(Clone)]
pub struct GuideMatchBudget {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

impl GuideMatchBudget {
    pub fn new(duration: Duration) -> Self {
        Self {
            deadline: Instant::now() + duration,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed) || Instant::now() >= self.deadline
    }

    pub fn check(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.stopped(), "Hosted guide match stopped");
        Ok(())
    }
}

#[derive(Default)]
struct GuideInterrupt {
    active: Mutex<Option<GuideMatchBudget>>,
}

struct ActiveGuideBudget<'a>(&'a GuideInterrupt);

impl Drop for ActiveGuideBudget<'_> {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

#[derive(Default)]
struct AliasNames {
    exact: HashMap<String, Vec<String>>,
    canonical: HashMap<String, Vec<String>>,
}

/// Batched XML events cross the VM boundary; the shared core owns record state.
pub struct GuideRecords(Context);

/// The host executes effects; the shared core owns refresh transitions and channel ownership.
pub struct GuideRefresh(Context);

fn context() -> anyhow::Result<Context> {
    let runtime = Runtime::new()?;
    runtime.set_max_stack_size(1024 * 1024);
    let context = Context::full(&runtime)?;
    checked(&context, |ctx| ctx.eval::<(), _>(CORE))?;
    Ok(context)
}

fn checked<T>(
    context: &Context,
    action: impl for<'js> FnOnce(Ctx<'js>) -> rquickjs::Result<T>,
) -> anyhow::Result<T> {
    context.with(|ctx| checked_in(ctx, action))
}

fn checked_in<'js, T>(
    ctx: Ctx<'js>,
    action: impl FnOnce(Ctx<'js>) -> rquickjs::Result<T>,
) -> anyhow::Result<T> {
    action(ctx.clone()).map_err(|error| {
        // Never log exception text containing provider names, URLs or credentials.
        if error.is_exception() {
            let _ = ctx.catch();
        }
        anyhow::anyhow!("Shared guide runtime: {error}")
    })
}

thread_local! { static SCALAR: RefCell<Option<Context>> = const { RefCell::new(None) }; }

fn scalar<T>(action: impl for<'js> FnOnce(Ctx<'js>) -> rquickjs::Result<T>) -> anyhow::Result<T> {
    SCALAR.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(context()?);
        }
        checked(slot.as_ref().expect("initialized above"), action)
    })
}

fn core<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<Object<'js>> {
    ctx.globals().get("OttPlayCore")
}

pub fn text<T: for<'js> FromJs<'js>>(method: &str, value: &str) -> anyhow::Result<T> {
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>(method)?
            .call((value, "rust"))
    })
}

pub fn unowned(existing: Vec<String>, incoming: Vec<String>) -> anyhow::Result<Vec<String>> {
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>("nativeGuideUnowned")?
            .call((existing, incoming))
    })
}

pub fn source_fresh(age: u64) -> anyhow::Result<bool> {
    // Saturating clock subtraction is supplied by Rust. Every age near the TTL is exact in JS.
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>("nativeGuideFresh")?
            .call((age as f64,))
    })
}

pub fn source_refresh(failed: bool, empty: bool, stale: bool) -> anyhow::Result<String> {
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>("nativeGuideRefresh")?
            .call((failed, empty, stale))
    })
}

pub fn evict_source_set(count: usize, existing: bool) -> anyhow::Result<bool> {
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>("nativeGuideEvictSourceSet")?
            .call((count as i32, existing))
    })
}

pub fn refresh_interval(consecutive_failures: u32) -> anyhow::Result<u64> {
    scalar(|ctx| {
        core(&ctx)?
            .get::<_, Function>("nativeGuideRefreshInterval")?
            .call((
                "rust-server",
                consecutive_failures.min(i32::MAX as u32) as i32,
            ))
    })
}

impl GuideRefresh {
    pub fn new(count: usize) -> anyhow::Result<Self> {
        let context = context()?;
        checked(&context, |ctx| {
            let constructor: Constructor = core(&ctx)?.get("NativeGuideRefresh")?;
            let refresh: Object = constructor.construct((count as f64, "rust-server"))?;
            ctx.globals().set("guideRefresh", refresh)
        })?;
        Ok(Self(context))
    }

    pub fn action(&self) -> anyhow::Result<String> {
        checked(&self.0, |ctx| {
            let refresh: Object = ctx.globals().get("guideRefresh")?;
            let method: Function = refresh.get("action")?;
            method.call((This(refresh),))
        })
    }

    pub fn index(&self) -> anyhow::Result<usize> {
        checked(&self.0, |ctx| {
            let refresh: Object = ctx.globals().get("guideRefresh")?;
            let method: Function = refresh.get("index")?;
            method.call((This(refresh),))
        })
    }

    pub fn advance(&self, succeeded: bool, available: bool) -> anyhow::Result<()> {
        checked(&self.0, |ctx| {
            let refresh: Object = ctx.globals().get("guideRefresh")?;
            let method: Function = refresh.get("advance")?;
            method.call((This(refresh), succeeded, available))
        })
    }

    pub fn unowned(&self, incoming: Vec<String>) -> anyhow::Result<Vec<String>> {
        checked(&self.0, |ctx| {
            let refresh: Object = ctx.globals().get("guideRefresh")?;
            let method: Function = refresh.get("unowned")?;
            method.call((This(refresh), incoming))
        })
    }
}

impl GuideIndex {
    pub fn new(rows: Vec<Vec<String>>) -> anyhow::Result<Self> {
        let context = context()?;
        checked(&context, |ctx| {
            let measure = Function::new(ctx.clone(), |value: String| value.len() as i32)?;
            let precision = ctx.eval::<Function, _>("Math.fround")?;
            let constructor: Constructor = core(&ctx)?.get("NativeGuide")?;
            let index: Object = constructor.construct((rows, "rust", measure, precision))?;
            ctx.globals().set("guideIndex", index)
        })?;
        Ok(Self(context, None, None))
    }

    /// Hosted HTTP clients retain the browser's ordered aliases, UTF-16 length
    /// and double precision. Legacy/native indexes keep their existing profile.
    pub fn web(rows: Vec<Vec<String>>) -> anyhow::Result<Self> {
        let context = context()?;
        checked(&context, |ctx| {
            let measure = ctx.eval::<Function, _>("(function(value) { return value.length; })")?;
            let precision = ctx.eval::<Function, _>("(function(value) { return value; })")?;
            let constructor: Constructor = core(&ctx)?.get("NativeGuide")?;
            let index: Object = constructor.construct((rows, "web", measure, precision))?;
            ctx.globals().set("guideIndex", index)
        })?;
        // Install once outside Context::with: changing runtime callbacks while
        // holding its mutex deadlocks. The active budget itself is swapped only
        // while that same context is serialized and is cleared before unlocking.
        let interrupt = Arc::new(GuideInterrupt::default());
        let active = interrupt.clone();
        context
            .runtime()
            .set_interrupt_handler(Some(Box::new(move || {
                active
                    .active
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .is_some_and(GuideMatchBudget::stopped)
            })));
        Ok(Self(context, None, Some(interrupt)))
    }

    fn with_web_budget<T>(
        &self,
        budget: &GuideMatchBudget,
        action: impl for<'js> FnOnce(Ctx<'js>) -> rquickjs::Result<T>,
    ) -> anyhow::Result<T> {
        budget.check()?;
        self.0.with(|ctx| {
            budget.check()?;
            let interrupt = self
                .2
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Web guide budget requires web profile"))?;
            *interrupt
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(budget.clone());
            let _reset = ActiveGuideBudget(interrupt);
            let result = checked_in(ctx, action);
            // Interruption is an error even if JS happened to return no match.
            budget.check()?;
            result
        })
    }

    /// Resolve and infer seconds with the unchanged web rules under one budget.
    pub fn resolve_web_with_budget(
        &self,
        id: &str,
        names: &[&str],
        shift_name: &str,
        budget: &GuideMatchBudget,
    ) -> anyhow::Result<Option<(String, i64)>> {
        self.with_web_budget(budget, |ctx| {
            let index: Object = ctx.globals().get("guideIndex")?;
            let method: Function = index.get("resolve")?;
            let found: Option<String> = method.call((This(index), id, names.to_vec()))?;
            found
                .map(|id| {
                    let hours: i32 = core(&ctx)?
                        .get::<_, Function>("nativeGuideShift")?
                        .call((shift_name, "web"))?;
                    Ok((id, i64::from(hours) * 3600))
                })
                .transpose()
        })
    }

    pub fn web_shift_seconds(&self, name: &str) -> anyhow::Result<i64> {
        checked(&self.0, |ctx| {
            core(&ctx)?.get::<_, Function>("nativeGuideShift")?.call::<_, i32>((name, "web"))
        }).map(|hours| i64::from(hours) * 3600)
    }

    /// HTTP snapshots retain every alias. The shared core owns normalization and
    /// unique-name selection; these maps only index its keys by distinct IDs.
    pub(crate) fn with_aliases(rows: Vec<Vec<String>>, aliases: Vec<Vec<String>>) -> anyhow::Result<Self> {
        let mut index = Self::new(rows)?;
        let keys: Vec<Vec<String>> = checked(&index.0, |ctx| {
            let normalize: Function = ctx.eval(
                "(function(core, rows) { return rows.map(function(row) { return [row[0], \
                 core.normalizedChannelName(row[1]), core.canonicalChannelName(row[1])]; }); })",
            )?;
            normalize.call((core(&ctx)?, aliases))
        })?;
        let mut names = AliasNames::default();
        for row in keys {
            let [id, exact, canonical]: [String; 3] = row.try_into()
                .map_err(|_| anyhow::anyhow!("Invalid shared guide alias keys"))?;
            for (map, key) in [(&mut names.exact, exact), (&mut names.canonical, canonical)] {
                if key.is_empty() { continue; }
                let ids = map.entry(key).or_default();
                if !ids.contains(&id) { ids.push(id.clone()); }
            }
        }
        index.1 = Some(Arc::new(names));
        Ok(index)
    }

    /// Reuse the loaded core when preparing playlist names on a new worker.
    pub fn extract_time_shift(&self, name: &str) -> anyhow::Result<i64> {
        checked(&self.0, |ctx| {
            core(&ctx)?
                .get::<_, Function>("nativeGuideShift")?
                .call::<_, i32>((name, "rust"))
        })
        .map(i64::from)
    }

    pub fn strip_time_shift(&self, name: &str) -> anyhow::Result<String> {
        checked(&self.0, |ctx| {
            core(&ctx)?
                .get::<_, Function>("nativeGuideStripShift")?
                .call((name, "rust"))
        })
    }

    pub fn slice(
        &self,
        times: Vec<Vec<f64>>,
        now: i64,
        archive: i64,
        shift: i64,
    ) -> anyhow::Result<Vec<Vec<f64>>> {
        checked(&self.0, |ctx| slice_in(&ctx, times, now, archive, shift))
    }

    pub fn match_name(&self, name: &str) -> anyhow::Result<Option<(String, f32)>> {
        checked(&self.0, |ctx| {
            if let Some(aliases) = &self.1 {
                let api = core(&ctx)?;
                let exact: String = api.get::<_, Function>("normalizedChannelName")?.call((name,))?;
                let canonical: String = api.get::<_, Function>("canonicalChannelName")?.call((name,))?;
                let exact = aliases.exact.get(&exact).cloned().unwrap_or_default();
                let canonical = aliases.canonical.get(&canonical).cloned().unwrap_or_default();
                if !exact.is_empty() || !canonical.is_empty() {
                    let found: Option<String> = api.get::<_, Function>("chooseGuideChannel")?
                        .call((Vec::<String>::new(), vec![exact], vec![canonical]))?;
                    // An ambiguous exact alias must not fall through to a random
                    // first normalized name in the legacy fuzzy index.
                    return Ok(found.map(|id| (id, 1.0)));
                }
            }
            let index: Object = ctx.globals().get("guideIndex")?;
            let method: Function = index.get("match")?;
            let found: Option<Object> = method.call((This(index), name))?;
            found
                .map(|row| Ok((row.get("id")?, row.get("score")?)))
                .transpose()
        })
    }

    pub fn resolve(&self, id: &str, names: &[&str]) -> anyhow::Result<Option<String>> {
        checked(&self.0, |ctx| {
            let index: Object = ctx.globals().get("guideIndex")?;
            let method: Function = index.get("resolve")?;
            method.call((This(index), id, names.to_vec()))
        })
    }
}

impl GuideRecords {
    pub fn new(native: bool) -> anyhow::Result<Self> {
        let context = context()?;
        checked(&context, |ctx| {
            let trim = rust_trim(&ctx)?;
            let identity = Function::new(ctx.clone(), |value: String| value)?;
            let constructor: Constructor = core(&ctx)?.get("XmltvRecords")?;
            let records: Object = constructor.construct((
                if native { "rust-native" } else { "rust" },
                trim,
                identity,
            ))?;
            ctx.globals().set("guideRecords", records)
        })?;
        Ok(Self(context))
    }

    pub fn accept(&self, rows: Vec<Vec<String>>) -> anyhow::Result<Vec<Vec<String>>> {
        checked(&self.0, |ctx| {
            let records: Object = ctx.globals().get("guideRecords")?;
            let method: Function = records.get("accept")?;
            method.call((This(records), rows))
        })
    }

    pub fn order(&self, starts: Vec<f64>) -> anyhow::Result<Vec<usize>> {
        checked(&self.0, |ctx| {
            core(&ctx)?
                .get::<_, Function>("nativeXmltvOrder")?
                .call((starts, "rust-native"))
        })
    }
}

fn rust_trim<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<Function<'js>> {
    let host = Function::new(ctx.clone(), |value: String| value.trim().to_owned())?;
    // Already-trimmed titles/descriptions should not copy their entire UTF-8
    // payload into Rust and back. ECMAScript trim covers Rust White_Space except
    // NEL (U+0085); its extra FEFF only sends an unchanged value to the fallback.
    // Keep Rust authoritative whenever either primitive could remove anything.
    let wrap: Function = ctx.eval(
        "(function(trim) { return function(value) {\
         if (value.charCodeAt(0) !== 133 && value.charCodeAt(value.length - 1) !== 133\
             && value.trim() === value) return value;\
         return trim(value); }; })",
    )?;
    wrap.call((host,))
}

pub fn slice(
    times: Vec<Vec<f64>>,
    now: i64,
    archive: i64,
    shift: i64,
) -> anyhow::Result<Vec<Vec<f64>>> {
    scalar(|ctx| slice_in(&ctx, times, now, archive, shift))
}

fn slice_in(
    ctx: &Ctx<'_>,
    times: Vec<Vec<f64>>,
    now: i64,
    archive: i64,
    shift: i64,
) -> rquickjs::Result<Vec<Vec<f64>>> {
    core(ctx)?.get::<_, Function>("nativeGuideSlice")?.call((
        times,
        now as f64,
        archive as f64,
        shift as f64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_budget_interrupts_js_deadline_and_restores_the_index() -> anyhow::Result<()> {
        let index = GuideIndex::web(vec![vec!["id".into(), "News".into()]])?;
        let budget = GuideMatchBudget::new(Duration::from_millis(20));
        let started = Instant::now();
        assert!(index
            .with_web_budget(&budget, |ctx| ctx.eval::<(), _>("for (;;) {}"))
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(index.2.as_ref().unwrap().active.lock().unwrap().is_none());
        assert_eq!(index.resolve("id", &[])?, Some("id".into()));
        let fresh = GuideMatchBudget::new(Duration::from_secs(1));
        assert_eq!(
            index.resolve_web_with_budget("id", &[], "News +7", &fresh)?,
            Some(("id".into(), 25200))
        );
        Ok(())
    }

    #[test]
    fn hosted_budget_cancels_active_js_and_does_not_cancel_another_call() -> anyhow::Result<()> {
        let index = GuideIndex::web(vec![vec!["id".into(), "News".into()]])?;
        let budget = GuideMatchBudget::new(Duration::from_secs(2));
        let (entered, waiting) = std::sync::mpsc::channel();
        let worker_index = index.clone();
        let worker_budget = budget.clone();
        let worker = std::thread::spawn(move || {
            worker_index.with_web_budget(&worker_budget, |ctx| {
                entered.send(()).unwrap();
                ctx.eval::<(), _>("for (;;) {}")
            })
        });
        waiting.recv_timeout(Duration::from_secs(1))?;
        let started = Instant::now();
        budget.cancel();
        // This call contends for the same context, then must get its own budget.
        let fresh = GuideMatchBudget::new(Duration::from_secs(1));
        assert_eq!(
            index.resolve_web_with_budget("id", &[], "News", &fresh)?,
            Some(("id".into(), 0))
        );
        assert!(worker.join().unwrap().is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!fresh.stopped());
        // A pre-cancelled request must fail rather than report a cache miss.
        assert!(index
            .resolve_web_with_budget("missing", &[], "", &budget)
            .is_err());
        Ok(())
    }

    #[test]
    fn hosted_budget_interrupted_fuzzy_query_recovers_the_complete_best_match() -> anyhow::Result<()>
    {
        use std::sync::atomic::AtomicUsize;
        let mut rows: Vec<Vec<String>> = (0..900)
            .map(|i| {
                vec![
                    format!("early-{i}"),
                    format!("Candidate Alpha padding words {i}"),
                ]
            })
            .collect();
        // The best non-exact match is last: a partial cached answer would be wrong.
        rows.push(vec!["winner".into(), "Candidate Alpha X".into()]);
        let index = GuideIndex::web(rows.clone())?;
        let armed_budget = Arc::new(std::sync::OnceLock::<GuideMatchBudget>::new());
        let interrupt_once = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        // Instrument the existing numeric-precision boundary, not the matcher:
        // its first invocation proves that actual fuzzy scoring has started.
        checked(&index.0, |ctx| {
            let cancel = armed_budget.clone();
            let once = interrupt_once.clone();
            let count = calls.clone();
            let precision = Function::new(ctx.clone(), move |value: f64| {
                count.fetch_add(1, Ordering::Relaxed);
                if once.swap(false, Ordering::Relaxed) {
                    cancel.get().expect("query budget is armed").cancel();
                }
                value
            })?;
            let measure = ctx.eval::<Function, _>("(function(value) { return value.length; })")?;
            let constructor: Constructor = core(&ctx)?.get("NativeGuide")?;
            let guide: Object = constructor.construct((rows.clone(), "web", measure, precision))?;
            ctx.globals().set("guideIndex", guide)
        })?;
        // Fixture construction is not part of the query's cancellation budget.
        let budget = GuideMatchBudget::new(Duration::from_secs(5));
        armed_budget.set(budget.clone()).ok().unwrap();
        let input = ["Candidate Alpha"];
        assert!(index
            .resolve_web_with_budget("", &input, input[0], &budget)
            .is_err());
        let interrupted_calls = calls.swap(0, Ordering::Relaxed);
        assert!(interrupted_calls > 0);
        let fresh = GuideIndex::web(rows)?;
        let fresh_budget = GuideMatchBudget::new(Duration::from_secs(5));
        let recovered = index.resolve_web_with_budget("", &input, input[0], &fresh_budget)?;
        // If only the outer budget check had failed after completion, the first
        // run would have made just as many scoring calls as this complete run.
        assert!(interrupted_calls < calls.load(Ordering::Relaxed));
        assert_eq!(
            recovered,
            fresh.resolve_web_with_budget("", &input, input[0], &fresh_budget)?
        );
        assert_eq!(recovered, Some(("winner".into(), 0)));
        Ok(())
    }

    #[test]
    fn record_trim_preserves_rust_unicode_boundaries() -> anyhow::Result<()> {
        let context = context()?;
        checked(&context, |ctx| {
            let trim = rust_trim(&ctx)?;
            let mut boundaries: Vec<char> = (0..=0x10ffff)
                .filter_map(char::from_u32)
                .filter(|c| c.is_whitespace())
                .collect();
            boundaries.extend(['\u{feff}', '\u{180e}', '\u{200b}', 'я', '🏆']);
            for edge in boundaries {
                for value in [
                    format!("{edge}Новости 🏆{edge}"),
                    format!("{edge}\u{feff}Новости\u{feff}{edge}"),
                    format!("\u{feff}{edge}Новости{edge}\u{feff}"),
                    format!("Новости{edge}культуры"),
                ] {
                    assert_eq!(trim.call::<_, String>((value.as_str(),))?, value.trim());
                }
            }
            for value in ["", "  ", "\n\t\r", "Новости\nкультуры", "\u{85}\u{feff}\u{85}"] {
                assert_eq!(trim.call::<_, String>((value,))?, value.trim());
            }
            Ok(())
        })
    }

    #[test]
    fn cloned_indexes_can_cross_worker_threads() -> anyhow::Result<()> {
        let index = GuideIndex::new(vec![vec!["id".into(), "News".into()]])?;
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let index = index.clone();
                scope.spawn(move || {
                    assert!(SCALAR.with(|slot| slot.borrow().is_none()));
                    for _ in 0..20 {
                        assert_eq!(index.extract_time_shift("News +2").unwrap(), 2);
                        let name = index.strip_time_shift("News +2").unwrap();
                        assert_eq!(
                            index.match_name(&name).unwrap(),
                            Some(("id".into(), 1.0))
                        );
                        assert_eq!(
                            index.slice(vec![vec![1000.0, 2000.0]], 1500, 0, 0).unwrap(),
                            vec![vec![0.0, 1000.0, 2000.0]]
                        );
                    }
                    // A fresh worker must not evaluate another complete core bundle.
                    assert!(SCALAR.with(|slot| slot.borrow().is_none()));
                });
            }
        });
        Ok(())
    }

    #[test]
    fn all_m3u_index_paths_reuse_the_core_on_fresh_workers() -> anyhow::Result<()> {
        use crate::{m3u, xmltv};
        use std::collections::HashMap;

        let channels = HashMap::from([("news".into(), xmltv::Channel {
            id: "news".into(), name: "News".into(), names: vec!["News".into()],
            icon: "https://fixture.test/news.png".into(),
        })]);
        let index = xmltv::build_match_index(&channels)?;
        std::thread::scope(|scope| -> anyhow::Result<()> {
            let mut workers = Vec::new();
            for _ in 0..8 {
                let index = index.clone();
                let channels = &channels;
                workers.push(scope.spawn(move || -> anyhow::Result<()> {
                    assert!(SCALAR.with(|slot| slot.borrow().is_none()));
                    let input = r#"[{"id":"1","name":"News +2"}]"#;
                    let body = "{}\n\t\n\n\t\n1-0-0-17~News%20%2B2";
                    let mut map = HashMap::new();
                    let mut shifts = HashMap::new();
                    m3u::match_channels_with_index(
                        serde_json::from_str(input)?, channels, &index, &mut map, &mut shifts,
                    )?;
                    m3u::match_logos_with_index(serde_json::from_str(input)?, channels, &index)?;
                    m3u::match_channels_text_with_index(body, channels, &index, &mut map, &mut shifts)?;
                    m3u::match_logos_text_with_index(body, channels, &index)?;
                    assert_eq!(shifts[&m3u::compute_epg_hash("news|2")], 2);
                    assert!(SCALAR.with(|slot| slot.borrow().is_none()));
                    Ok(())
                }));
            }
            for worker in workers {
                worker.join().expect("M3U worker panicked")?;
            }
            Ok(())
        })?;
        Ok(())
    }

    #[test]
    fn exceptions_are_errors_without_disclosing_input_and_context_recovers() -> anyhow::Result<()> {
        let context = context()?;
        let error = checked(&context, |ctx| {
            ctx.eval::<(), _>("throw new Error('provider-secret')")
        })
        .unwrap_err();
        assert!(!error.to_string().contains("provider-secret"));
        assert_eq!(checked(&context, |ctx| ctx.eval::<i32, _>("1 + 1"))?, 2);
        Ok(())
    }

    #[test]
    fn utf8_float_precision_and_unicode_shifts_cross_the_real_bridge() -> anyhow::Result<()> {
        let index = GuideIndex::new(vec![
            vec!["first".into(), "яa".into()],
            vec!["second".into(), "abc".into()],
        ])?;
        assert_eq!(index.match_name("яabc")?, Some(("first".into(), 0.6_f32)));
        assert_eq!(text::<String>("nativeGuideName", "First +𝟜h HD")?, "first");
        assert_eq!(text::<i32>("nativeGuideShift", "First +𝟜h")?, 0);
        for name in ["", "News", "News +2", "News -12h HD", "First +𝟜h HD", "РЕН ТВ +7"] {
            assert_eq!(
                index.extract_time_shift(name)?,
                i64::from(text::<i32>("nativeGuideShift", name)?)
            );
            assert_eq!(
                index.strip_time_shift(name)?,
                text::<String>("nativeGuideStripShift", name)?
            );
        }
        Ok(())
    }
}
