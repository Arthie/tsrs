#!/usr/bin/env node
// Measures tsrs-lint's memory and CPU use on a workspace from generate.mjs (notes/mem-lint-retention.md). Each run is one headless
// request with every file of the chosen projects and no rules, as oxlint sends with `typeAware` and `typeCheck` and
// every rule off.
//
//   node bench/lint-retention/measure.mjs <command> [--workspace DIR] [--bin PATH] [options]
//
// Commands (each prints a Markdown table and writes the raw samples to --json if given):
//   scaling  one request per program count in --programs (default 100,200,400,800): peak memory, and with --trace the
//            per-program growth of each store (TSRS_LINT_MEM_TRACE).
//   batches  the same --programs files as one request, then split into k requests run one after another, for each k in
//            --batches (default 1,2,4,8).
//   cpu      wall time, CPU time and CPUs used for one request and for --parallel requests (default 2) splitting the
//            same files, for each core count in --cpus (default 2,4,8). Linux pins with taskset (std's
//            available_parallelism follows the affinity mask); macOS cannot pin, so it runs with RAYON_NUM_THREADS=n,
//            which also makes tsrs-lint check one program at a time with n checkers.
//   check    one request over every file; fails if tsrs-lint reports any diagnostic.
//
// Options: --workspace (default: generated into bench/.work/lint-retention-<projects>-<seed> with --projects, default
// 1000, and --seed, default 1), --bin (default target/release/tsrs-lint; a `tsrs` binary runs as `tsrs --lint`, which
// installs the allocator hooks behind the trace's heap field), --runs (default 1), --trace (per-program
// lines; `purge` also purges the allocator after each program), --env K=V (repeatable), --cgroup DIR (Linux: run in
// this cgroup v2 and sample its memory.stat anon every 100 ms; peak anon is then the memory figure), --json FILE.
//
// Memory: the peak physical footprint on macOS (`/usr/bin/time -l`), which counts compressed memory, unlike the
// resident set; the maximum resident set (`/usr/bin/time -v`) or the cgroup's peak anon on Linux.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "../..");
const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        workspace: { type: "string" },
        projects: { type: "string", default: "1000" },
        seed: { type: "string", default: "1" },
        bin: { type: "string", default: path.join(ROOT, "target/release/tsrs-lint") },
        programs: { type: "string" },
        batches: { type: "string", default: "1,2,4,8" },
        cpus: { type: "string", default: "2,4,8" },
        parallel: { type: "string", default: "2" },
        runs: { type: "string", default: "1" },
        trace: { type: "string" },
        env: { type: "string", multiple: true, default: [] },
        cgroup: { type: "string" },
        json: { type: "string" },
    },
});
const command = positionals[0];
if (!["scaling", "batches", "cpu", "check"].includes(command)) {
    console.error("usage: measure.mjs scaling|batches|cpu|check [--workspace DIR] [--bin PATH] [options] (see the header)");
    process.exit(2);
}
const list = (text) => text.split(",").map(Number);
const GiB = 1024 ** 3,
    MiB = 1024 ** 2;
const gib = (bytes) => (bytes / GiB).toFixed(2);
const mib = (bytes) => (bytes / MiB).toFixed(0);
const LINUX = process.platform === "linux";

const workspace = path.resolve(opts.workspace ?? path.join(ROOT, `bench/.work/lint-retention-${opts.projects}-${opts.seed}`));
if (!fs.existsSync(path.join(workspace, "workspace.json"))) {
    run(process.execPath, [path.join(import.meta.dirname, "generate.mjs"), "--out", workspace, "--projects", opts.projects, "--seed", opts.seed]);
}
const { projects } = JSON.parse(fs.readFileSync(path.join(workspace, "workspace.json"), "utf8"));
const bin = path.resolve(opts.bin);
if (!fs.existsSync(bin)) throw new Error(`${bin} does not exist: cargo build --release -p tsrs_lint`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lint-retention-"));
const extraEnv = Object.fromEntries(opts.env.map((pair) => pair.split(/=(.*)/s).slice(0, 2)));
const results = { command, workspace, bin, machine: machine(), env: extraEnv, samples: [] };

function run(file, args) {
    const result = spawnSync(file, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed`);
}

function machine() {
    const cpus = os.cpus();
    return `${os.type()} ${os.release()} ${os.arch()}, ${cpus[0]?.model ?? "?"}, ${cpus.length} CPUs, ${gib(os.totalmem())} GiB`;
}

// Projects spread evenly over the sorted folder order until they hold at least `programs` programs.
function selectProjects(programs) {
    const total = projects.reduce((n, p) => n + p.programs.length, 0);
    if (programs >= total) return projects;
    let count = Math.max(1, Math.round((programs / total) * projects.length));
    for (;;) {
        const chosen = Array.from({ length: count }, (_, i) => projects[Math.floor((i * projects.length) / count)]);
        if (chosen.reduce((n, p) => n + p.programs.length, 0) >= programs || count >= projects.length) return chosen;
        count++;
    }
}
const filesOf = (chosen) => chosen.flatMap((p) => p.programs.flatMap((q) => q.files)).map((f) => path.join(workspace, f));
const programCount = (chosen) => chosen.reduce((n, p) => n + p.programs.length, 0);

function request(files) {
    const file = path.join(work, `request-${files.length}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 2, configs: [{ file_paths: files, rules: [] }], source_overrides: {}, report_syntactic: true, report_semantic: true }));
    return file;
}

// Runs one headless request; resolves to its measurements, frames and trace lines.
function lint(files, { env = {}, cpus } = {}) {
    const req = request(files);
    const timeFile = path.join(work, `time-${Math.random().toString(36).slice(2)}.txt`);
    let argv = ["/usr/bin/time", LINUX ? "-v" : "-l", "-o", timeFile, bin, ...(path.basename(bin) === "tsrs" ? ["--lint"] : []), "headless"];
    if (cpus && LINUX) argv = ["taskset", "-c", `0-${cpus - 1}`, ...argv];
    if (opts.cgroup) argv = ["sh", "-c", `echo $$ > "${opts.cgroup}/cgroup.procs" && exec "$@"`, "sh", ...argv];
    const environment = { ...process.env, ...extraEnv, ...env };
    if (opts.trace) environment.TSRS_LINT_MEM_TRACE = opts.trace;
    return new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const child = spawn(argv[0], argv.slice(1), { cwd: workspace, env: environment, stdio: [fs.openSync(req, "r"), "pipe", "pipe"] });
        const out = [],
            err = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        let anonPeak = 0;
        const sampler = opts.cgroup && setInterval(() => {
            const stat = fs.readFileSync(path.join(opts.cgroup, "memory.stat"), "utf8");
            anonPeak = Math.max(anonPeak, Number(/^anon (\d+)/m.exec(stat)?.[1] ?? 0));
        }, 100);
        child.on("error", reject);
        child.on("close", (code) => {
            if (sampler) clearInterval(sampler);
            const wall = Number(process.hrtime.bigint() - started) / 1e9;
            const stderr = Buffer.concat(err).toString();
            if (code !== 0) return reject(new Error(`tsrs-lint exited with ${code}:\n${stderr.slice(-2000)}`));
            const time = fs.readFileSync(timeFile, "utf8");
            const num = (re) => Number(re.exec(time)?.[1] ?? NaN);
            const minutes = (text) => text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
            const sample = LINUX
                ? { user: num(/User time \(seconds\): ([\d.]+)/), sys: num(/System time \(seconds\): ([\d.]+)/), peak: num(/Maximum resident set size \(kbytes\): (\d+)/) * 1024, wallTime: minutes(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): ([\d:.]+)/.exec(time)?.[1] ?? "0") }
                : { user: num(/([\d.]+) user/), sys: num(/([\d.]+) sys/), peak: num(/(\d+)\s+peak memory footprint/), maxRss: num(/(\d+)\s+maximum resident set size/) };
            if (opts.cgroup) sample.peak = anonPeak;
            sample.wall = wall;
            sample.frames = frames(Buffer.concat(out));
            sample.trace = stderr.split("\n").filter((l) => l.startsWith("tsrs-lint trace ")).map((l) => JSON.parse(l.slice(16)));
            sample.split = stderr.split("\n").filter((l) => l.startsWith("tsrs mem split") || l.startsWith("  ")).join("\n");
            resolve(sample);
        });
    });
}

function frames(buffer) {
    const messages = [];
    for (let offset = 0; offset + 5 <= buffer.length; ) {
        const length = buffer.readUInt32LE(offset);
        messages.push({ type: buffer[offset + 4], ...JSON.parse(buffer.subarray(offset + 5, offset + 5 + length).toString()) });
        offset += 5 + length;
    }
    return messages;
}

function table(header, rows) {
    console.log(`| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |`);
    for (const row of rows) console.log(`| ${row.join(" | ")} |`);
    console.log();
}

function fit(points) {
    const n = points.length,
        mx = points.reduce((s, [x]) => s + x, 0) / n,
        my = points.reduce((s, [, y]) => s + y, 0) / n;
    const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0),
        sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    const slope = sxx ? sxy / sxx : 0;
    return { slope, intercept: my - slope * mx };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function repeated(files, options) {
    const samples = [];
    for (let i = 0; i < Number(opts.runs); i++) samples.push(await lint(files, options));
    const best = samples.sort((a, b) => a.wall - b.wall)[Math.floor(samples.length / 2)];
    return { ...best, peak: median(samples.map((s) => s.peak)), wall: median(samples.map((s) => s.wall)) };
}

// The per-program store sizes of a traced run, first and last program and growth per program.
function traceSummary(trace) {
    const programs = trace.filter((t) => t.event === "program").sort((a, b) => a.end_ms - b.end_ms);
    if (programs.length < 2) return;
    const stores = {
        "memory after program": (t) => t.memory,
        "memory before purge": (t) => t.memory_before_purge,
        "program thread scratch region (allocated)": (t) => t.thread_scratch?.allocated,
        "program thread scratch region (used)": (t) => t.thread_scratch?.used,
        "shared regions (allocated)": (t) => t.shared.allocated,
        "read_cache text": (t) => t.read_cache.bytes,
        "thread arenas (used, TSRS_MEM_SPLIT)": (t) => t.thread_arenas?.used,
    };
    const rows = [];
    for (const [name, get] of Object.entries(stores)) {
        const points = programs.map((t, i) => [i + 1, get(t)]).filter(([, y]) => y !== undefined);
        if (!points.length) continue;
        const { slope } = fit(points);
        rows.push([name, mib(points[0][1]), mib(points.at(-1)[1]), (slope / 1024).toFixed(0)]);
    }
    const discovery = trace.find((t) => t.event === "discovery");
    if (discovery?.request_scratch) rows.push(["request scratch region after discovery (allocated)", mib(discovery.request_scratch.allocated), "", ""]);
    const counts = programs.at(-1);
    console.log(`Stores after each of ${programs.length} programs (shared: ${counts.shared.regions} regions, ${counts.shared.files} declaration files, ${counts.shared.references} references; read_cache: ${counts.read_cache.entries} entries):\n`);
    table(["store", "after first (MiB)", "after last (MiB)", "growth per program (KiB, least squares)"], rows);
}

// The most programs in flight at once, from the traced start and end times.
function concurrency(trace) {
    const events = trace.filter((t) => t.event === "program").flatMap((t) => [[t.start_ms, 1], [t.end_ms, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0,
        max = 0;
    for (const [, d] of events) max = Math.max(max, (now += d));
    const threads = new Set(trace.filter((t) => t.event === "program").map((t) => t.thread));
    return { max, threads: threads.size };
}

const memoryLabel = opts.cgroup ? "peak anon (GiB)" : LINUX ? "peak RSS (GiB)" : "peak footprint (GiB)";
console.log(`tsrs-lint ${command}: ${bin}\nworkspace ${workspace} (${projects.length} projects)\nmachine ${results.machine}\n` +
    (Object.keys(extraEnv).length ? `env ${JSON.stringify(extraEnv)}\n` : ""));

if (command === "check") {
    const files = filesOf(projects);
    const sample = await lint(files);
    const diagnostics = sample.frames.filter((f) => f.type === 1);
    console.log(`${programCount(projects)} programs, ${files.length} files: ${diagnostics.length} diagnostics, ${gib(sample.peak)} GiB, ${sample.wall.toFixed(1)} s`);
    for (const d of diagnostics.slice(0, 20)) console.log(`  ${d.file_path}: ${d.message.id} ${d.message.help || d.message.description}`);
    if (diagnostics.length) process.exitCode = 1;
}

if (command === "scaling") {
    const rows = [];
    const points = [];
    for (const n of list(opts.programs ?? "100,200,400,800")) {
        const chosen = selectProjects(n);
        const files = filesOf(chosen);
        const sample = await repeated(files);
        const programs = programCount(chosen);
        points.push([programs, sample.peak]);
        results.samples.push({ programs, files: files.length, ...sample, frames: undefined });
        const diagnostics = sample.frames.filter((f) => f.type === 1).length;
        rows.push([programs, chosen.length, files.length, gib(sample.peak), (sample.peak / programs / MiB).toFixed(1), sample.wall.toFixed(1), ((sample.user + sample.sys) / sample.wall).toFixed(2), diagnostics]);
        if (sample.trace.length) {
            traceSummary(sample.trace);
        }
    }
    table(["programs", "projects", "files", memoryLabel, "MiB per program", "wall (s)", "CPUs used", "diagnostics"], rows);
    if (points.length > 1) {
        const { slope, intercept } = fit(points);
        console.log(`Least-squares fit: ${mib(slope)} MiB per program + ${gib(intercept)} GiB.\n`);
    }
}

if (command === "batches") {
    const chosen = selectProjects(Number(opts.programs ?? 800));
    const rows = [];
    for (const k of list(opts.batches)) {
        // Contiguous batches in sorted folder order, as separate oxlint runs over folder groups would be.
        const batches = Array.from({ length: k }, (_, i) => chosen.slice(Math.floor((i * chosen.length) / k), Math.floor(((i + 1) * chosen.length) / k)));
        const samples = [];
        for (const batch of batches) samples.push(await repeated(filesOf(batch)));
        const peaks = samples.map((s) => s.peak);
        const wall = samples.reduce((t, s) => t + s.wall, 0),
            cpu = samples.reduce((t, s) => t + s.user + s.sys, 0);
        results.samples.push({ batches: k, samples: samples.map((s) => ({ ...s, frames: undefined })) });
        rows.push([k, Math.round(programCount(chosen) / k), gib(Math.max(...peaks)), peaks.map(gib).join(" / "), wall.toFixed(1), cpu.toFixed(1)]);
    }
    console.log(`${programCount(chosen)} programs, ${filesOf(chosen).length} files:\n`);
    table(["requests", "programs per request", `largest ${memoryLabel}`, "each request", "total wall (s)", "total CPU (s)"], rows);
}

if (command === "cpu") {
    const chosen = selectProjects(Number(opts.programs ?? 400));
    const parallel = Number(opts.parallel);
    if (!LINUX) console.log("macOS cannot pin CPUs: each core count n runs with RAYON_NUM_THREADS=n, uncapped (see the header).\n");
    const rows = [];
    opts.trace ??= "1";
    for (const cpus of list(opts.cpus)) {
        const env = LINUX ? {} : { RAYON_NUM_THREADS: String(cpus) };
        const one = await repeated(filesOf(chosen), { env, cpus });
        const parts = Array.from({ length: parallel }, (_, i) => chosen.filter((_, j) => j % parallel === i));
        const started = process.hrtime.bigint();
        const many = await Promise.all(parts.map((part) => lint(filesOf(part), { env, cpus })));
        const wall = Number(process.hrtime.bigint() - started) / 1e9;
        const cpu = many.reduce((t, s) => t + s.user + s.sys, 0);
        const { max, threads } = concurrency(one.trace);
        results.samples.push({ cpus, one: { ...one, frames: undefined }, parallel: many.map((s) => ({ ...s, frames: undefined })), parallelWall: wall });
        rows.push([cpus, threads, max, one.wall.toFixed(1), (one.user + one.sys).toFixed(1), ((one.user + one.sys) / one.wall).toFixed(2), gib(one.peak), wall.toFixed(1), cpu.toFixed(1), (cpu / wall).toFixed(2), `${(100 * (1 - wall / one.wall)).toFixed(0)}%`]);
    }
    console.log(`${programCount(chosen)} programs, ${filesOf(chosen).length} files; ${parallel} requests in parallel split the projects round-robin:\n`);
    table(["cores", "lint-program threads", "programs at once (max)", "1 request wall (s)", "CPU (s)", "CPUs used", memoryLabel, `${parallel} requests wall (s)`, "CPU (s)", "CPUs used", "faster"], rows);
}

if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(results, null, 1) + "\n");
fs.rmSync(work, { recursive: true, force: true });
