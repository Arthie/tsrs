#!/usr/bin/env node
// Writes a synthetic TypeScript monorepo for the tsrs-lint retention and CPU benchmarks (notes/mem-lint-retention.md).
//
//   node bench/lint-retention/generate.mjs --out DIR [--projects 400] [--files-per-project 20] [--core-libs 6]
//       [--apps-percent 3] [--foundation-percent 10] [--examples-percent 10] [--paths 1868] [--framework-decls 3000]
//       [--seed 1]
//
// Each project is solution-style: `tsconfig.json` extends the root `tsconfig.base.json`, lists no files and refers to
// `tsconfig.src.json`, `tsconfig.test.json` and sometimes `examples/tsconfig.json`, so a folder holds two or three
// programs. Every library has a path alias in the base config, padded with unused aliases to `--paths` entries.
// Library files import a few "core" libraries (a UI kit, i18n, query and test helpers) and up to two "foundation"
// libraries by alias; applications sort first and import dozens of libraries. Stand-in typings for a UI framework, a
// stream library, a test runner, node and an examples tool are generated under `node_modules/`, so nothing is
// installed. Output is deterministic for a seed, and the workspace has no type errors.
//
// Writes `workspace.json` next to the sources: every project in sorted folder order with its programs and files.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
    options: {
        out: { type: "string" },
        projects: { type: "string", default: "400" },
        "files-per-project": { type: "string", default: "20" },
        "core-libs": { type: "string", default: "6" },
        "apps-percent": { type: "string", default: "3" },
        "foundation-percent": { type: "string", default: "10" },
        "examples-percent": { type: "string", default: "10" },
        paths: { type: "string", default: "1868" },
        "framework-decls": { type: "string", default: "3000" },
        seed: { type: "string", default: "1" },
    },
});
if (!opts.out) {
    console.error("usage: generate.mjs --out DIR [--projects N] [--files-per-project F] [--core-libs K] [--seed S] ...");
    process.exit(2);
}
const int = (name) => {
    const value = Number(opts[name]);
    if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a nonnegative integer`);
    return value;
};
const N = int("projects"),
    F = int("files-per-project"),
    K = Math.max(4, int("core-libs")),
    SEED = int("seed");
const out = path.resolve(opts.out);

// mulberry32
let state = SEED >>> 0 || 1;
function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;
// Skewed sizes: lognormal around the mean, most projects small, a few near 25 times the mean.
function size(mean) {
    const u = Math.max(random(), 1e-9),
        v = random();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(2, Math.min(Math.round(mean * 25), Math.round(mean * 0.55 * Math.exp(0.9 * normal))));
}

let written = 0;
function write(file, text) {
    const full = path.join(out, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    written++;
}
const json = (value) => JSON.stringify(value, null, 2) + "\n";

// ---- Projects -------------------------------------------------------------------------------------------------
const AREAS = ["accounts", "billing", "catalog", "checkout", "content", "data", "insights", "media", "messaging",
    "onboarding", "platform", "reports", "search", "settings", "shared", "sync", "teams", "users", "workflow"];
const CORE_NAMES = ["ui-kit", "i18n", "query", "test-helpers"];
// Probability that a library file imports each core library (the UI kit is imported almost everywhere).
const CORE_WEIGHTS = [0.55, 0.45, 0.35, 0];

const apps = [],
    libs = [];
const appCount = Math.max(1, Math.round((N * int("apps-percent")) / 100));
for (let i = 0; i < appCount; i++) apps.push({ kind: "app", dir: `apps/app-${String(i).padStart(3, "0")}` });
for (let k = 0; k < K; k++) {
    const name = k < CORE_NAMES.length ? CORE_NAMES[k] : `core-${k}`;
    libs.push({ kind: "core", core: k, dir: `libs/shared/${name}`, alias: `@scope/shared/${name}` });
}
const otherLibs = Math.max(0, N - appCount - K);
const foundationCount = Math.max(1, Math.round((otherLibs * int("foundation-percent")) / 100));
for (let i = 0; i < otherLibs; i++) {
    const area = AREAS[i % AREAS.length];
    const name = `${area === "shared" ? "common" : "feature"}-${String(i).padStart(4, "0")}`;
    libs.push({ kind: i < foundationCount ? "foundation" : "lib", dir: `libs/${area}/${name}`, alias: `@scope/${area}/${name}` });
}
const projects = [...apps, ...libs].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
projects.forEach((p, i) => {
    p.id = i;
    p.prefix = p.kind === "core" ? `C${p.core}` : `${p.kind === "app" ? "A" : "L"}${i}`;
    const mean = p.kind === "app" ? F * 3 : p.kind === "core" ? F * 3 : F;
    const total = size(mean);
    p.specs = Math.max(1, Math.round(total * 0.35));
    p.sources = Math.max(1, total - p.specs);
    p.examples = p.kind !== "core" && chance(int("examples-percent") / 100);
    p.testing = p.kind === "core" ? p.core === 3 : p.kind !== "app" && chance(0.3);
});
const foundations = projects.filter((p) => p.kind === "foundation");
const importable = projects.filter((p) => p.kind === "foundation" || p.kind === "lib");
const cores = projects.filter((p) => p.kind === "core").sort((a, b) => a.core - b.core);
for (const p of projects) {
    if (p.kind === "lib") p.deps = Array.from({ length: Math.floor(random() * 3) }, () => pick(foundations));
    else if (p.kind === "app") p.deps = Array.from({ length: 20 + Math.floor(random() * 21) }, () => pick(importable));
    else p.deps = [];
    p.deps = [...new Set(p.deps)].filter((d) => d !== p);
}

// ---- Root config ----------------------------------------------------------------------------------------------
const paths = {};
for (const p of projects) {
    if (!p.alias) continue;
    paths[p.alias] = [`./${p.dir}/src/index.ts`];
    if (p.testing) paths[`${p.alias}/testing`] = [`./${p.dir}/testing/index.ts`];
}
for (let i = 0; Object.keys(paths).length < int("paths"); i++) {
    const area = AREAS[i % AREAS.length];
    paths[`@scope/${area}/unused-${String(i).padStart(4, "0")}`] = [`./libs/${area}/unused-${String(i).padStart(4, "0")}/src/index.ts`];
}
write("tsconfig.base.json", json({
    compileOnSave: false,
    compilerOptions: {
        rootDir: ".",
        sourceMap: true,
        declaration: false,
        moduleResolution: "bundler",
        emitDecoratorMetadata: false,
        experimentalDecorators: true,
        isolatedModules: true,
        target: "es2015",
        module: "esnext",
        lib: ["es2022", "dom"],
        skipLibCheck: true,
        allowJs: true,
        resolveJsonModule: true,
        esModuleInterop: true,
        strict: true,
        typeRoots: ["node_modules/@types", "types"],
        paths,
    },
    exclude: ["node_modules", "tmp"],
}));
write("package.json", json({ name: "lint-retention-workspace", private: true }));
write(".oxlintrc.json", json({
    options: { typeAware: true, typeCheck: true },
    categories: { correctness: "off", suspicious: "off", pedantic: "off", perf: "off", style: "off", restriction: "off", nursery: "off" },
    plugins: [],
    rules: {},
}));
write("types/global.d.ts", "declare const APP_VERSION: string;\ninterface Window { appConfig?: Record<string, string> }\n");

// ---- Stand-in packages ----------------------------------------------------------------------------------------
function pkg(dir, types) {
    write(`node_modules/${dir}/package.json`, json({ name: dir.replace(/^@types\//, "@types/"), version: "1.0.0", types: "index.d.ts" }));
    write(`node_modules/${dir}/index.d.ts`, types);
}
pkg("streams", `export interface Subscription { unsubscribe(): void; readonly closed: boolean }
export interface Operator<A, B> { (source: Stream<A>): Stream<B> }
export declare class Stream<T> {
  subscribe(next?: (value: T) => void, error?: (error: unknown) => void): Subscription;
  pipe(): Stream<T>;
  pipe<A>(op1: Operator<T, A>): Stream<A>;
  pipe<A, B>(op1: Operator<T, A>, op2: Operator<A, B>): Stream<B>;
  pipe<A, B, C>(op1: Operator<T, A>, op2: Operator<A, B>, op3: Operator<B, C>): Stream<C>;
  pipe<A, B, C, D>(op1: Operator<T, A>, op2: Operator<A, B>, op3: Operator<B, C>, op4: Operator<C, D>): Stream<D>;
}
export declare function of<T>(...values: T[]): Stream<T>;
export declare function map<T, R>(project: (value: T, index: number) => R): Operator<T, R>;
export declare function filter<T>(predicate: (value: T, index: number) => boolean): Operator<T, T>;
export declare function flatMap<T, R>(project: (value: T, index: number) => Stream<R>): Operator<T, R>;
export declare function zip<A, B>(a: Stream<A>, b: Stream<B>): Stream<[A, B]>;
export declare function distinct<T>(compare?: (a: T, b: T) => boolean): Operator<T, T>;
`);
// The UI framework: its public API, then generated declarations standing in for the bulk of a framework's typings.
let framework = `import { Stream } from "streams";
export interface Type<T> extends Function { new (...args: any[]): T }
export declare class Token<T> { constructor(description: string); readonly _type?: T }
export interface ViewOptions { name: string; template?: string; imports?: unknown[] }
export declare function View(options: ViewOptions): ClassDecorator;
export declare function Service(options?: { scope?: "app" | "view" | null }): ClassDecorator;
export declare function Prop(alias?: string): PropertyDecorator;
export declare function Event(alias?: string): PropertyDecorator;
export declare function use<T>(token: Type<T> | Token<T>): T;
export interface State<T> { (): T }
export interface WritableState<T> extends State<T> { set(value: T): void; update(fn: (value: T) => T): void; readonly(): State<T> }
export declare function state<T>(initial: T): WritableState<T>;
export declare function derived<T>(fn: () => T): State<T>;
export declare class Emitter<T> extends Stream<T> { emit(value: T): void }
export declare class Http {
  get<T>(url: string, options?: { params?: Record<string, string | number> }): Stream<T>;
  post<T, B = unknown>(url: string, body: B): Stream<T>;
}
`;
const frameworkDecls = Math.max(1, int("framework-decls"));
for (let i = 0; i < frameworkDecls; i++) {
    const prev = i > 0 ? `Settings${i - 1}` : "object";
    framework += `export interface Settings${i} { key${i}: string; level: number; parent?: ${prev}; flags: Partial<Record<"a" | "b" | "c", boolean>> }
export declare class Part${i}<T extends object = Settings${i}> {
  readonly settings: Settings${i};
  get<K extends keyof T>(key: K): T[K];
  with<U extends object>(value: U): Part${i}<T & U>;
  watch(): Stream<T>;
}
`;
}
pkg("@stand-in/ui", framework);
pkg("@types/testing", `declare namespace testing {
  interface Matchers<R, T = unknown> {
    toBe(expected: T): R; toEqual(expected: unknown): R; toBeTruthy(): R; toBeDefined(): R;
    toHaveBeenCalled(): R; toHaveBeenCalledWith(...args: unknown[]): R; toHaveLength(length: number): R;
    not: Matchers<R, T>;
  }
  interface Mock<A extends unknown[] = unknown[], R = unknown> { (...args: A): R; mock: { calls: A[] } }
  function fn<A extends unknown[] = unknown[], R = unknown>(impl?: (...args: A) => R): Mock<A, R>;
}
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function beforeEach(fn: () => void | Promise<void>): void;
declare function expect<T>(actual: T): testing.Matchers<void, T>;
`);
pkg("@types/node", `declare var process: { env: Record<string, string | undefined>; cwd(): string; argv: string[] };
declare var __dirname: string;
declare module "node:path" { export function join(...parts: string[]): string; export function resolve(...parts: string[]): string }
`);
pkg("@stand-in/examples", `export interface Meta<T> { title: string; view: abstract new (...args: any[]) => T; args?: Partial<T> }
export interface Example<T> { args?: Partial<T>; name?: string }
`);

// ---- Sources --------------------------------------------------------------------------------------------------
// A source file of a project: a model, a service and a view, using what it imports.
function sourceFile(p, j) {
    const P = p.prefix;
    const imports = new Map(); // alias -> Set of names
    const add = (from, name) => {
        if (!imports.has(from)) imports.set(from, new Set());
        imports.get(from).add(name);
    };
    const used = [];
    if (p.kind !== "core") {
        cores.forEach((c, k) => {
            const weight = k < CORE_WEIGHTS.length ? CORE_WEIGHTS[k] : 0.12;
            if (chance(p.kind === "app" ? Math.min(1, weight * 1.5) : weight)) {
                const name = `${c.prefix}_Service${Math.floor(random() * c.sources)}`;
                add(c.alias, name);
                used.push(name);
            }
        });
        const deps = p.kind === "app" ? Array.from({ length: 3 }, () => pick(p.deps)).filter(Boolean) : p.deps.filter(() => chance(0.4));
        for (const d of new Set(deps)) {
            const name = `${d.prefix}_Service${p.kind === "app" ? 0 : Math.floor(random() * d.sources)}`;
            add(d.alias, name);
            used.push(name);
        }
    }
    let text = `import { View, Service, Prop, use, state, derived, Http, Part${j % frameworkDecls} } from "@stand-in/ui";
import { Stream, of, map, filter, flatMap, zip } from "streams";
`;
    for (const [from, names] of imports) text += `import { ${[...names].join(", ")} } from "${from}";\n`;
    if (j > 0) text += `import { ${P}_Model${j - 1}, ${P}_Service${j - 1} } from "./file-${j - 1}";\n`;
    text += `
export interface ${P}_Model${j} {
  id: string;
  title: string;
  tags: ReadonlyArray<string>;
  score: number;
  extra: Partial<Record<"a" | "b" | "c", number>>;${j > 0 ? `\n  parent?: ${P}_Model${j - 1};` : ""}
}

export type ${P}_Key${j} = keyof ${P}_Model${j};
export type ${P}_Patch${j} = { [K in ${P}_Key${j}]?: ${P}_Model${j}[K] };

@Service({ scope: "app" })
export class ${P}_Service${j} {
  private readonly http = use(Http);
  readonly items = state<${P}_Model${j}[]>([]);
  readonly total = derived(() => this.items().reduce((sum, item) => sum + item.score, 0));

  load(id: string): Stream<${P}_Model${j}> {
    return this.http.get<${P}_Model${j}>(\`/api/${P.toLowerCase()}/\${id}\`).pipe(
      filter((item) => item.score >= 0),
      map((item) => ({ ...item, title: item.title.trim() })),
    );
  }

  patch(item: ${P}_Model${j}, patch: ${P}_Patch${j}): ${P}_Model${j} {
    return { ...item, ...patch };
  }

  search(term: string): Stream<string[]> {
    return of(term).pipe(
      flatMap((value) => this.load(value)),
      map((item) => item.tags.filter((tag) => tag.includes(term))),
    );
  }
}

@View({ name: "${P.toLowerCase()}-${j}", template: "" })
export class ${P}_View${j} {
  @Prop() model: ${P}_Model${j} | null = null;
  private readonly service = use(${P}_Service${j});
  private readonly part = use(Part${j % frameworkDecls}).with({ id: "${P}" });
  readonly count = derived(() => this.service.items().length);
  readonly id = this.part.get("id");
`;
    if (j > 0) {
        text += `  private readonly previous = use(${P}_Service${j - 1});
  readonly both = zip(this.service.load("a"), this.previous.load("b")).pipe(map(([a, b]) => a.score + b.score));
`;
    }
    used.forEach((name, n) => {
        text += `  private readonly dep${n} = use(${name});
  readonly depTotal${n} = derived(() => this.dep${n}.total() + this.count());
  readonly depTags${n} = this.dep${n}.search("x").pipe(map((tags) => tags.length));
`;
    });
    text += "}\n";
    return text;
}

function specFile(p, j) {
    const P = p.prefix;
    const helpers = cores[3];
    return `import { ${P}_Model${j}, ${P}_Service${j} } from "./file-${j}";
import { fixture, createSpy } from "${helpers.alias}";

describe("${P}_Service${j}", () => {
  it("patches a model", () => {
    const service = new ${P}_Service${j}();
    const model = fixture<${P}_Model${j}>({ id: "1", title: "t", tags: [], score: 1, extra: {} });
    expect(service.patch(model, { score: 2 }).score).toBe(2);
    const spy = createSpy<(value: number) => void>();
    spy(1);
    expect(spy.calls).toHaveLength(1);
    const mock = testing.fn((value: string) => value.length);
    expect(mock("ab")).toBe(2);
  });
});
`;
}

const workspace = { generator: { ...opts, out: undefined }, projects: [] };
for (const p of projects) {
    const files = { main: [], spec: [], examples: [] };
    const main = "tsconfig.src.json";
    const add = (kind, file, text) => {
        write(`${p.dir}/${file}`, text);
        files[kind].push(`${p.dir}/${file}`);
    };
    const depth = p.dir.split("/").length;
    const up = "../".repeat(depth);
    const references = [{ path: `./${main}` }, { path: "./tsconfig.test.json" }];
    if (p.examples) references.push({ path: "./examples/tsconfig.json" });
    write(`${p.dir}/tsconfig.json`, json({ extends: `${up}tsconfig.base.json`, files: [], include: [], references }));
    write(`${p.dir}/${main}`, json({
        extends: "./tsconfig.json",
        compilerOptions: { outDir: `${up}dist`, declaration: true, types: [] },
        exclude: ["src/**/*.test.ts", "src/**/*.mock.ts", "testing/**/*", "src/**/*.example.ts", "examples/**/*", "test.config.ts", "src/test-setup.ts"],
        include: ["**/*.ts"],
    }));
    write(`${p.dir}/tsconfig.test.json`, json({
        extends: "./tsconfig.json",
        compilerOptions: { outDir: `${up}dist`, types: ["testing", "node"] },
        files: ["src/test-setup.ts"],
        include: ["test.config.ts", "src/**/*.test.ts", "src/**/*.mock.ts", "**/*.d.ts", "testing/**/*.ts"],
    }));
    const dir = p.kind === "app" ? "src/app" : "src/lib";
    for (let j = 0; j < p.sources; j++) add("main", `${dir}/file-${j}.ts`, sourceFile(p, j));
    if (p.kind === "core" && p.core === 3) {
        add("main", "src/lib/helpers.ts", `export function fixture<T>(value: T): T {
  return value;
}

export function createSpy<F extends (...args: any[]) => void>(): F & { calls: Parameters<F>[] } {
  const calls: Parameters<F>[] = [];
  const spy = ((...args: Parameters<F>) => {
    calls.push(args);
  }) as unknown as F & { calls: Parameters<F>[] };
  spy.calls = calls;
  return spy;
}
`);
    }
    let index = "";
    for (let j = 0; j < p.sources; j++) index += `export * from "./${dir.slice(4)}/file-${j}";\n`;
    if (p.kind === "core" && p.core === 3) index += `export * from "./lib/helpers";\n`;
    if (p.kind === "app") add("main", "src/main.ts", `import { ${p.prefix}_View0 } from "./app/file-0";\n\nexport const root = ${p.prefix}_View0;\n`);
    else add("main", "src/index.ts", index);
    for (let j = 0; j < p.specs; j++) add("spec", `${dir}/file-${j % p.sources}.${Math.floor(j / p.sources)}.test.ts`, specFile(p, j % p.sources));
    add("spec", "src/test-setup.ts", `import { fixture } from "${cores[3].alias}";\n\nfixture("setup");\n`);
    add("spec", "test.config.ts", `export default {\n  name: "${p.dir}",\n  preset: "${up}test.preset.js",\n  coverageDirectory: "${up}coverage/${p.dir}",\n};\n`);
    if (p.testing) {
        add("spec", "testing/index.ts", `import { ${p.prefix}_Model0 } from "../src/index";\n\nexport function make${p.prefix}(): ${p.prefix}_Model0 {\n  return { id: "1", title: "t", tags: [], score: 0, extra: {} };\n}\n`);
    }
    if (p.examples) {
        write(`${p.dir}/examples/tsconfig.json`, json({
            extends: "../tsconfig.json",
            compilerOptions: { emitDecoratorMetadata: true },
            include: ["../src/**/*.example.ts", "*.ts"],
        }));
        add("examples", `${dir}/file-0.example.ts`, `import type { Meta, Example } from "@stand-in/examples";
import { ${p.prefix}_View0 } from "./file-0";

const meta: Meta<${p.prefix}_View0> = { title: "${p.dir}", view: ${p.prefix}_View0 };
export default meta;
export const Primary: Example<${p.prefix}_View0> = { args: { model: null } };
`);
    }
    const programs = [{ config: `${p.dir}/${main}`, files: files.main }, { config: `${p.dir}/tsconfig.test.json`, files: files.spec }];
    if (p.examples) programs.push({ config: `${p.dir}/examples/tsconfig.json`, files: files.examples });
    workspace.projects.push({ dir: p.dir, kind: p.kind, programs });
}
fs.writeFileSync(path.join(out, "workspace.json"), JSON.stringify(workspace) + "\n");
const programs = workspace.projects.reduce((n, p) => n + p.programs.length, 0);
const files = workspace.projects.reduce((n, p) => n + p.programs.reduce((m, q) => m + q.files.length, 0), 0);
const base = fs.statSync(path.join(out, "tsconfig.base.json")).size;
console.log(`${out}: ${workspace.projects.length} projects (${apps.length} apps, ${K} core libraries, ${foundations.length} foundation), ` +
    `${programs} programs, ${files} lint files, ${written} files written, tsconfig.base.json ${(base / 1024).toFixed(0)} KB with ${Object.keys(paths).length} paths`);
