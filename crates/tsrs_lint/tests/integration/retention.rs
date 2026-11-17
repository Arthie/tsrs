// One headless request over many tsconfig programs must not keep each program's memory until the request ends
// (notes/mem-lint-retention.md, bench/lint-retention). Ignored until that is fixed: it fails today.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use tsrs_core::json::{self, Value};

const PROJECTS: usize = 60;
/// Programs linted before the growth is measured: the first ones fill the caches every program shares.
const WARMUP: usize = 10;
/// `paths` aliases in the base config every project extends, as in a large monorepo's `tsconfig.base.json`.
const ALIASES: usize = 2000;

fn write(root: &Path, file: &str, text: &str) {
    let path = root.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

// Projects that each extend one large base config; every project is a program of its own.
fn workspace(root: &Path) -> Vec<String> {
    let paths: Vec<String> =
        (0..ALIASES).map(|i| format!(r#""@ws/lib-{i}":["./libs/lib-{i}/src/index.ts"]"#)).collect();
    write(
        root,
        "tsconfig.base.json",
        &format!(
            r#"{{"compilerOptions":{{"target":"es2022","module":"esnext","moduleResolution":"bundler","strict":true,"types":[],"paths":{{{}}}}}}}"#,
            paths.join(",")
        ),
    );
    let mut files = Vec::new();
    for i in 0..PROJECTS {
        write(
            root,
            &format!("libs/lib-{i}/tsconfig.json"),
            r#"{"extends":"../../tsconfig.base.json","include":["src/**/*.ts"]}"#,
        );
        let file = format!("libs/lib-{i}/src/index.ts");
        let import = if i > 0 {
            format!("import {{ value{} }} from \"@ws/lib-{}\";\n", i - 1, i - 1)
        } else {
            String::new()
        };
        let previous = if i > 0 { format!("value{}", i - 1) } else { "0".to_owned() };
        write(root, &file, &format!("{import}export const value{i}: number = {previous} + 1;\n"));
        files.push(root.join(file).to_string_lossy().into_owned());
    }
    files
}

fn field(value: &Value, path: &[&str]) -> f64 {
    let mut value = value;
    for key in path {
        let Value::Object(map) = value else { panic!("{key}: not an object") };
        value = &map[*key];
    }
    let Value::Number(number) = value else { panic!("{path:?}: not a number") };
    *number
}

#[test]
#[ignore = "fails until a headless request frees each program's tsconfig parse (notes/mem-lint-retention.md)"]
fn programs_in_one_request_do_not_accumulate_memory() {
    let root = std::env::temp_dir().join(format!("tsrs-lint-retention-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let files = workspace(&root);
    let request = json::marshal(&tsrs_lint::protocol::object([
        ("version", Value::Number(2.0)),
        (
            "configs",
            Value::Array(vec![tsrs_lint::protocol::object([
                ("file_paths", Value::Array(files.into_iter().map(Value::String).collect())),
                ("rules", Value::Array(Vec::new())),
            ])]),
        ),
        ("report_syntactic", Value::Bool(true)),
        ("report_semantic", Value::Bool(true)),
    ]))
    .unwrap();
    // One program at a time on one checker, so the thread's scratch region and the process's memory after each
    // program are those of the programs before it.
    let mut child = Command::new(env!("CARGO_BIN_EXE_tsrs-lint"))
        .current_dir(&root)
        .env("TSRS_LINT_MEM_TRACE", "1")
        .env("RAYON_NUM_THREADS", "1")
        .arg("headless")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(request.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    let mut programs: Vec<Value> = stderr
        .lines()
        .filter_map(|line| line.strip_prefix("tsrs-lint trace "))
        .map(|line| json::unmarshal(line).unwrap())
        .filter(|trace| matches!(trace, Value::Object(map) if map["event"] == Value::String("program".into())))
        .collect();
    programs.sort_by(|a, b| field(a, &["end_ms"]).total_cmp(&field(b, &["end_ms"])));
    assert_eq!(programs.len(), PROJECTS, "{stderr}");
    let (first, last) = (&programs[WARMUP], &programs[PROJECTS - 1]);
    let measured = (PROJECTS - 1 - WARMUP) as f64;
    let per_program = |path: &[&str]| (field(last, path) - field(first, path)) / measured / 1024.0;
    let scratch = per_program(&["thread_scratch", "allocated"]);
    let memory = per_program(&["memory"]);
    // A program's own memory goes back once it is linted: what stays per program is its result, a few KiB here.
    assert!(
        scratch < 16.0 && memory < 64.0,
        "growth per program after the first {WARMUP}: program thread scratch region {scratch:.0} KiB, process memory \
         {memory:.0} KiB"
    );
}
