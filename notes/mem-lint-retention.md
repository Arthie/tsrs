# mem-lint-retention: a tsrs-lint request keeps every tsconfig parse until it ends

A large private monorepo linted with oxlint's type-aware mode (one `tsrs-lint headless` request carrying every file,
about 2,000 tsconfig programs) showed two problems: memory grew with each program linted until the request ended, and
the process used about half of the CPUs it was given. This note reproduces both on a generated workspace that has the
same shape (no code from that repo), finds the store that grows, and measures the CPU use. Nothing is fixed here.

Measured on an Apple M1 Pro (10 CPUs, 32 GiB, macOS 26.7.3) at 7eb504db plus the instrumentation below, release
builds. Memory is the physical footprint (`/usr/bin/time -l`), as macOS RSS misleads.

## Reproduction

`bench/lint-retention` (options in the header of each script):

    node bench/lint-retention/measure.mjs scaling --programs 100,200,400,800,1600,2105

generates the workspace on first use (`generate.mjs --projects 1000 --seed 1`: 1,000 solution-style projects, 2,105 programs,
20,683 lint files, a `tsconfig.base.json` with 1,868 `paths` aliases that every project's tsconfigs extend), sends one
headless request over an even spread of the projects, and prints:

| programs | projects | files | peak footprint (GiB) | MiB per program | wall (s) | CPUs used |
| --- | --- | --- | --- | --- | --- | --- |
| 101 | 48 | 1,095 | 0.58 | 5.9 | 0.7 | 4.49 |
| 202 | 95 | 2,061 | 1.00 | 5.1 | 1.3 | 4.54 |
| 405 | 190 | 3,840 | 1.87 | 4.7 | 2.6 | 4.53 |
| 807 | 380 | 8,165 | 3.50 | 4.4 | 5.4 | 4.22 |
| 1,602 | 760 | 15,618 | 6.78 | 4.3 | 12.7 | 3.70 |
| 2,105 | 1,000 | 20,683 | 8.86 | 4.3 | 22.7 | 2.50 |

Least squares: 4 MiB per program + 0.18 GiB. With `RAYON_NUM_THREADS=4` (oxlint's setting at 4 to 7 cores): 1.75 GiB
at 405 programs and 6.67 GiB at 1,602, the same 4 MiB per program.

Splitting the same 807 programs into batches of contiguous projects, one request each, run in sequence
(`measure.mjs batches --programs 800`):

| requests | programs per request | largest peak (GiB) | total wall (s) | total CPU (s) |
| --- | --- | --- | --- | --- |
| 1 | 807 | 3.53 | 6.0 | 24.2 |
| 2 | 404 | 1.89 | 5.9 | 23.8 |
| 4 | 202 | 1.05 | 6.1 | 24.1 |
| 8 | 101 | 0.64 | 6.6 | 23.8 |

The peak follows the programs in one request, not the work: the memory belongs to the request.

`crates/tsrs_lint/tests/integration/retention.rs` (ignored; run with
`cargo test -p tsrs_lint --test integration retention -- --ignored`) is the same in small: 60 projects extending a base
with 2,000 aliases, one program at a time. It fails today with 469 KiB per program of program-thread scratch region and
1,792 to 1,966 KiB per program of process memory (two runs), against bounds of 16 KiB and 64 KiB.

## What grows

`TSRS_LINT_MEM_TRACE=1` (new, `crates/tsrs_lint/src/memtrace.rs`) prints a JSON line after discovery and after each
program has been linted and freed; with `TSRS_MEM_SPLIT=1` and the `tsrs --lint` binary, which installs the allocator
hooks, it also has the mimalloc heap's live bytes. `measure.mjs scaling --trace 1` fits each store per program. 406
programs, `RAYON_NUM_THREADS=4` (one program at a time), `TSRS_MEM_SPLIT=1`:

| store | after the first program (MiB) | after the last (MiB) | per program (KiB) |
| --- | --- | --- | --- |
| process memory | 1,068 | 1,798 | 1,769 |
| mimalloc live heap | 762 | 1,294 | 1,332 |
| program thread's scratch region (allocated) | 1 | 265 | 594 |
| arena reservation in use | 395 | 668 | 600 |
| `Shared` regions (63 declaration files) | 42 | 42 | 0 |
| `read_cache` file text | 3 | 11 | 11 |

- **Allocator retention: no.** `TSRS_LINT_MEM_TRACE=purge` (`mi_collect(true)` before each reading) reads the same
  memory before and after.
- **`shared`: no.** Flat: the 63 declaration files of the stand-in packages, no project references kept.
- **`read_cache`: barely.** 11 KiB per program, the text of the files read.
- **The program thread's scratch region: yes, 0.6 MiB per program**, and the reservation grows by the same amount:
  every other region a program makes (loader, checker and file regions) goes back.
- **The live heap: yes, 1.3 MiB per program**, the rest of the growth.

What the heap holds: a system-allocator build (`--features tsrs_cli/system-alloc`) run under `MallocStackLogging`,
stopped after programs 60 and 300 of 426, then `malloc_history -allBySize` at both points and diffed by stack. Of the
347 MiB that grew over those 240 programs (1.44 MiB per program), 332 MiB was allocated under
`tsrs_tsoptions::tsconfigparsing::parse_extended_config` → `parse_config` → `convert_property_value_to_json` and
`parsinghelpers::parse_string_map` (the strings, arrays and index maps of the base config's `paths`; 448,320 = 240 ×
1,868 allocations per stack), called from `tsrs_lint::engine::lint_program` →
`get_parsed_command_line_of_config_file`. About 5 MiB was parser diagnostic text of the stand-in packages' `.d.ts`
files.

Why it stays: `create_program` (`crates/tsrs_lint/src/engine.rs:564`) puts the parsed config in an arena (`P::new`),
which runs the value's destructor only when its region is dropped. On a `lint-program` thread the current region is
the thread's scratch region (`engine.rs:368`), which is kept until the request ends. So each program's
`ParsedCommandLine`, its extended base config included, and every heap allocation it owns stay for the request: 0.6
MiB of region and 1.4 MiB of heap per program here, most of it the base's 1,868 aliases parsed again for every
program (no extended-config cache in lint mode).

Discovery does the same on the calling thread, before any program runs. `find_tsconfig` parses every program's
tsconfig into the request's scratch region (`engine.rs:257`), which is also kept until the request ends:

| programs | memory after discovery (MiB) | request scratch region (MiB) | discovery (ms, one thread) |
| --- | --- | --- | --- |
| 405 | 1,004 | 331 | 781 |
| 1,602 | 3,968 | 1,262 | 3,304 |

2.5 MiB per program, from the start of the request to its end; this is the constant part of each request's peak that
grows with its program count (1,068 MiB of the 1,798 above).

Check of the diagnosis: an experiment (reverted, not a fix: nothing checked that no program data escapes) that gave
each program a scratch region of its own, dropped after the program:

| programs | peak before (GiB) | peak with the experiment (GiB) |
| --- | --- | --- |
| 405 | 1.87 | 1.23 |
| 1,602 | 6.78 | 4.24 |
| 2,105 | 8.86 | 5.47 |

Under it the memory after each program grew by 0.09 to 0.16 MiB per program instead of 1.8, the retention test
passed, and what was left of the peak was discovery's 2.5 MiB per program. The two retained parses account for nearly
all of the growth.

Still unknown: whether the region of the program thread holds anything besides the config (the region's used bytes
were not split by type), and the share of the remaining 0.1 MiB per program.

## CPU use

`program_threads` (`engine.rs:487`) is `cores / 4` clamped to `1..=programs`, and 1 whenever `RAYON_NUM_THREADS` is
set, which oxlint does. Each program checks on its own pool of checkers (at least 4 under the fast preset), but the
programs here have about 10 files each, so a pool rarely fills, and discovery runs on one thread before any program
starts.

macOS cannot pin a process to cores, so `measure.mjs cpu` sets `RAYON_NUM_THREADS=n` without a CPU cap (on Linux it
also runs under `taskset`). 405 programs; "2 requests" splits the projects round-robin into two requests run at once:

| n | program threads | programs at once | 1 request wall (s) | CPUs used | 2 requests wall (s) | CPUs used | faster |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 1 | 6.3 | 1.17 | 2.6 | 2.77 | 59% |
| 4 | 1 | 1 | 4.3 | 1.97 | 2.5 | 3.63 | 42% |
| 8 | 1 | 1 | 3.8 | 2.79 | 2.2 | 5.38 | 41% |

At 4 threads one request uses about 2 of 4 CPUs (the reported 55%), and two programs at once do the same work 42%
sooner with the same CPU time. Without `RAYON_NUM_THREADS` the 10-core machine runs 2 programs at once and uses 4.5
CPUs, falling to 2.5 at 2,105 programs, where wall time grows faster than the program count (12.7 s for 1,602, 22.7 s
for 2,105); not investigated.

## Instrumentation added

- `crates/tsrs_lint/src/memtrace.rs`: `TSRS_LINT_MEM_TRACE=1|purge` (see its header and docs/DEBUGGING.md).
- `tsrs_core::memsplit::{arena_totals, heap_stats, reservation_in_use, process_memory_now}`.
- `tsrs --lint` installs the allocator hooks (`set_heap_hooks`) before it hands off to tsrs_lint, so `TSRS_MEM_SPLIT`
  and the trace's heap field work in lint mode through `tsrs`; the standalone `tsrs-lint` binary has no hooks.
