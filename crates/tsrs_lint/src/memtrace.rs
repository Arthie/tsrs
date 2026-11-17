//! `TSRS_LINT_MEM_TRACE` (debug stat): where a headless request's memory goes, program by program
//! (bench/lint-retention).
//!
//! `1` prints one line per tsconfig program on stderr once the program has been linted and freed, and one after project
//! discovery: `tsrs-lint trace ` followed by a JSON object with the process's memory (the physical footprint on macOS,
//! the resident set on Linux) and the size of each store that lives for the whole request: the program thread's scratch
//! region, the calling thread's scratch region (discovery), the regions of the programs' `Shared` state, the file text
//! cache, and with `TSRS_MEM_SPLIT` also set, the thread arenas. `purge` also has the allocator give its freed memory
//! back before the reading and records the reading from before the purge, which separates memory the allocator retains
//! from memory still in use. The purge and the `heap` field (the allocator's live blocks, with `TSRS_MEM_SPLIT` set)
//! need the allocator hooks, which `tsrs --lint` installs and the standalone `tsrs-lint` binary does not.
//!
//! The thread arena totals read arenas that other threads may be allocating in when programs run at once: approximate
//! unless one program runs at a time.

use std::fmt::Write;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Off,
    On,
    Purge,
}

fn mode() -> Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    *MODE.get_or_init(|| match std::env::var("TSRS_LINT_MEM_TRACE").as_deref() {
        Ok("1") => Mode::On,
        Ok("purge") => Mode::Purge,
        _ => Mode::Off,
    })
}

/// Whether `TSRS_LINT_MEM_TRACE` is `1` or `purge`. Read once.
pub fn enabled() -> bool {
    mode() != Mode::Off
}

// Relaxed (all): statistics read after the request's threads have joined or between programs; no other memory is
// published through them.
static READ_ENTRIES: AtomicUsize = AtomicUsize::new(0);
static READ_BYTES: AtomicUsize = AtomicUsize::new(0);
static START: OnceLock<Instant> = OnceLock::new();

/// Counts a file text stored in the request's read cache.
pub fn note_read(text: Option<&str>) {
    // Relaxed: statistics only (see the statics).
    READ_ENTRIES.fetch_add(1, Ordering::Relaxed);
    // Relaxed: statistics only.
    READ_BYTES.fetch_add(text.map_or(0, str::len), Ordering::Relaxed);
}

/// Starts a request: the times of the lines that follow are relative to now, and the cache counts start at zero.
pub fn start_request() {
    let _ = START.set(Instant::now());
    // Relaxed (both): set before the request's threads start.
    READ_ENTRIES.store(0, Ordering::Relaxed);
    // Relaxed: as above.
    READ_BYTES.store(0, Ordering::Relaxed);
}

fn now_ms() -> f64 {
    START.get().map_or(0.0, |start| start.elapsed().as_secs_f64() * 1000.0)
}

/// The sizes of the request's `Shared` state.
pub struct SharedStats {
    pub regions: usize,
    pub allocated: usize,
    pub files: usize,
    pub references: usize,
}

/// One program's line.
pub struct Program<'a> {
    pub index: usize,
    pub config: &'a str,
    pub files: usize,
    pub start_ms: f64,
    pub thread_scratch: Option<&'a tsrs_core::arena::Region>,
    pub shared: SharedStats,
}

/// The time since the request started, for `Program::start_ms`.
pub fn program_start() -> f64 {
    now_ms()
}

/// After project discovery, on the calling thread: its scratch region holds the parsed tsconfigs.
pub fn discovery(programs: usize, files: usize) {
    let mut line = String::new();
    let _ = write!(
        line,
        "{{\"event\":\"discovery\",\"ms\":{:.1},\"programs\":{programs},\"files\":{files}",
        now_ms()
    );
    write_region(&mut line, "request_scratch", tsrs_core::arena::current_region().as_ref());
    finish(line, "after discovery");
}

/// After a program has been linted and freed, on its `lint-program` thread.
pub fn program(program: &Program<'_>) {
    let mut line = String::new();
    let _ = write!(
        line,
        "{{\"event\":\"program\",\"index\":{},\"thread\":{},\"config\":{},\"files\":{},\"start_ms\":{:.1},\"end_ms\":{:.1}",
        program.index,
        quote(std::thread::current().name().unwrap_or("")),
        quote(program.config),
        program.files,
        program.start_ms,
        now_ms(),
    );
    write_region(&mut line, "thread_scratch", program.thread_scratch);
    let _ = write!(
        line,
        ",\"shared\":{{\"regions\":{},\"allocated\":{},\"files\":{},\"references\":{}}}",
        program.shared.regions,
        program.shared.allocated,
        program.shared.files,
        program.shared.references
    );
    finish(line, &format!("after program {}", program.index));
}

fn write_region(line: &mut String, name: &str, region: Option<&tsrs_core::arena::Region>) {
    if let Some(region) = region {
        let _ = write!(
            line,
            ",\"{name}\":{{\"allocated\":{},\"used\":{}}}",
            region.allocated_bytes(),
            region.used_bytes()
        );
    }
}

fn finish(mut line: String, point: &str) {
    // Relaxed (both loads): statistics; a reading during other programs may miss their latest counts.
    let entries = READ_ENTRIES.load(Ordering::Relaxed);
    // Relaxed: as above.
    let bytes = READ_BYTES.load(Ordering::Relaxed);
    let _ = write!(line, ",\"read_cache\":{{\"entries\":{entries},\"bytes\":{bytes}}}");
    if let Some((count, capacity, used)) = tsrs_core::memsplit::arena_totals() {
        let _ = write!(
            line,
            ",\"thread_arenas\":{{\"count\":{count},\"capacity\":{capacity},\"used\":{used}}}"
        );
    }
    // The heap walk visits every page of every thread's heap: only with `TSRS_MEM_SPLIT`, as the arena totals.
    if let Some(heap) =
        tsrs_core::memsplit::enabled().then(tsrs_core::memsplit::heap_stats).flatten()
    {
        let _ = write!(
            line,
            ",\"heap\":{{\"live\":{},\"committed\":{},\"resident\":{}}}",
            heap.used, heap.capacity, heap.resident
        );
    }
    let _ = write!(line, ",\"reservation\":{}", tsrs_core::memsplit::reservation_in_use());
    let before = tsrs_core::memsplit::process_memory_now();
    if mode() == Mode::Purge {
        // `mi_collect(true)` through the hook the `tsrs` binary installs: the calling thread's heap, the abandoned
        // heaps of exited threads, and the purge of every arena's freed pages.
        tsrs_core::memsplit::heap_collect(true);
        let _ = write!(line, ",\"memory_before_purge\":{before}");
    }
    let _ = write!(line, ",\"memory\":{}}}", tsrs_core::memsplit::process_memory_now());
    eprintln!("tsrs-lint trace {line}");
    tsrs_core::memsplit::report(point);
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
