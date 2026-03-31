import * as path from "path";
import * as vscode from "vscode";
import { Minimatch } from "minimatch";
import { ConfigManager } from "./config";
import {
  TimingLog,
  logTiming,
} from "./timing";
import {
  resolveTag,
  stripVariablePrefix,
  parsePattern,
  looksLikeDirectory,
} from "./resolver";
import {
  ExtractedGlobs,
  FileTagConfig,
  TagSetExpression,
  ViewCondition,
} from "./types";

type UriMap = Map<string, vscode.Uri>;

export interface ViewSnapshot {
  uris: vscode.Uri[];
  version: number;
}

export interface ViewEntriesUpdateEvent {
  view: string;
  added: vscode.Uri[];
  removed: vscode.Uri[];
  reason: string;
  version: number;
}

export interface ViewRefreshEvent {
  view: string;
  reason: string;
}

interface CompiledPattern {
  base: vscode.Uri;
  glob: string;
  includeChildren: boolean;
  matcher: Minimatch;
  recursiveMatcher?: Minimatch;
}

interface TagState {
  name: string;
  rawPatterns: string[];
  compiled: CompiledPattern[];
  uris: UriMap;
  loaded: boolean;
}

interface ViewState {
  name: string;
  expr: TagSetExpression;
  dependsOnTags: Set<string>;
  uris: UriMap;
  version: number;
}

type FileMutationKind = "create" | "delete" | "change";

interface EvaluateOptions {
  trace?: string;
  forceReloadTags?: boolean;
  useCacheOnly?: boolean;
}

export class FileTagEngine implements vscode.Disposable {
  private config: FileTagConfig | undefined;
  private tagStates = new Map<string, TagState>();
  private viewStates = new Map<string, ViewState>();
  private disposables: vscode.Disposable[] = [];
  private fsWatcher: vscode.FileSystemWatcher | undefined;
  private readonly _onDidUpdateViewEntries = new vscode.EventEmitter<ViewEntriesUpdateEvent>();
  readonly onDidUpdateViewEntries = this._onDidUpdateViewEntries.event;
  private readonly _onDidRequireFullRefresh = new vscode.EventEmitter<ViewRefreshEvent>();
  readonly onDidRequireFullRefresh = this._onDidRequireFullRefresh.event;
  private pendingChangeUris = new Map<string, vscode.Uri>();
  private changeFlushHandle: NodeJS.Timeout | undefined;

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly configManager: ConfigManager,
  ) {}

  async init(): Promise<void> {
    await this.configManager.ensureExists();
    await this.reloadConfig();

    this.disposables.push(
      this.configManager.onDidChange(async () => {
        await this.reloadConfig();
        for (const view of this.viewStates.values())
          if (view.version > 0)
            this._onDidRequireFullRefresh.fire({ view: view.name, reason: "configChanged" });
      }),
    );

    this.setupWorkspaceWatcher();
  }

  dispose(): void {
    this.tagStates.clear();
    this.viewStates.clear();
    this.fsWatcher?.dispose();
    this.fsWatcher = undefined;
    if (this.changeFlushHandle) {
      clearTimeout(this.changeFlushHandle);
      this.changeFlushHandle = undefined;
    }
    this.pendingChangeUris.clear();
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidUpdateViewEntries.dispose();
    this._onDidRequireFullRefresh.dispose();
  }

  getConfig(): FileTagConfig | undefined {
    return this.config;
  }

  async evaluateView(viewName: string, options: { forceReload?: boolean; trace?: string } = {}): Promise<ViewSnapshot> {
    const view = this.viewStates.get(viewName);
    if (!view) return { uris: [], version: 0 };

    const timing = new TimingLog(`evaluateView(${viewName})`);
    try {
      const map = await this.evaluateExpression(view.expr, {
        trace: options.trace ?? `view:${viewName}`,
        forceReloadTags: options.forceReload,
      });
      view.uris = map;
      view.version++;
      const uris = Array.from(map.values());
      timing.step("resolve expression", `${uris.length} files`);
      timing.end();
      return { uris, version: view.version };

    } catch (error) {
      timing.fail(error);
      throw error;
    }
  }

  async getViewSnapshot(viewName: string, options: { forceReload?: boolean; trace?: string } = {}): Promise<ViewSnapshot> {
    const view = this.viewStates.get(viewName);
    if (!view) return { uris: [], version: 0 };
    if (options.forceReload || view.version === 0)
      return this.evaluateView(viewName, options);
    return { uris: Array.from(view.uris.values()), version: view.version };
  }

  async evaluateTags(tagNames: string[], traceLabel: string): Promise<vscode.Uri[]> {
    const timing = new TimingLog(traceLabel);
    try {
      const map = await this.evaluateTagsNode(tagNames, { trace: traceLabel, forceReloadTags: true });
      const uris = Array.from(map.values());
      timing.step("resolve tags", `${uris.length} files`);
      timing.end();
      return uris;

    } catch (error) {
      timing.fail(error);
      throw error;
    }
  }

  async getSearchGlobs(viewName: string): Promise<ExtractedGlobs> {
    const expr = this.viewStates.get(viewName)?.expr;
    if (!expr) return { include: "", exclude: "" };
    return this.extractGlobs(expr);
  }

  async notifyFileCreated(reason: string, uris: readonly vscode.Uri[]): Promise<void> {
    for (const uri of uris)
      await this.handleMutation("create", uri, reason);
  }

  async notifyFileDeleted(reason: string, uris: readonly vscode.Uri[]): Promise<void> {
    for (const uri of uris)
      await this.handleMutation("delete", uri, reason);
  }

  async notifyFileChanged(reason: string, uris: readonly vscode.Uri[]): Promise<void> {
    for (const uri of uris)
      await this.handleMutation("change", uri, reason);
  }

  async notifyFileRenamed(reason: string, files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    for (const file of files) {
      await this.handleMutation("delete", file.oldUri, reason);
      await this.handleMutation("create", file.newUri, reason);
    }
  }

  private setupWorkspaceWatcher(): void {
    this.fsWatcher?.dispose();
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, "**/*"),
    );

    this.disposables.push(
      this.fsWatcher,
      this.fsWatcher.onDidChange(uri => this.handleFileChange(uri)),
      this.fsWatcher.onDidCreate(uri => { void this.handleMutation("create", uri, "watcher"); }),
      this.fsWatcher.onDidDelete(uri => { void this.handleMutation("delete", uri, "watcher"); }),
    );
  }

  private handleFileChange(uri: vscode.Uri): void {
    const key = uri.toString();
    this.pendingChangeUris.set(key, uri);
    if (this.changeFlushHandle) return;

    this.changeFlushHandle = setTimeout(() => {
      const changes = Array.from(this.pendingChangeUris.values());
      this.pendingChangeUris.clear();
      this.changeFlushHandle = undefined;
      for (const changeUri of changes)
        void this.handleMutation("change", changeUri, "watcher");
    }, 750);
  }

  private async reloadConfig(): Promise<void> {
    this.config = await this.configManager.read();
    this.tagStates.clear();
    this.viewStates.clear();

    if (!this.config) return;

    for (const [name, patterns] of Object.entries(this.config.tags))
      this.tagStates.set(name, this.createTagState(name, patterns ?? []));

    for (const [name, condition] of Object.entries(this.config.views)) {
      const expr = this.normalizeCondition(condition);
      if (!expr) continue;
      this.viewStates.set(name, {
        name,
        expr,
        dependsOnTags: this.collectDependencies(expr),
        uris: new Map<string, vscode.Uri>(),
        version: 0,
      });
    }
  }

  private createTagState(name: string, patterns: string[]): TagState {
    return {
      name,
      rawPatterns: patterns,
      compiled: patterns.map(pattern => this.compilePattern(pattern)),
      uris: new Map<string, vscode.Uri>(),
      loaded: false,
    };
  }

  private compilePattern(pattern: string): CompiledPattern {
    const { base, glob } = parsePattern(pattern, this.workspaceFolder);
    const normalized = glob.replace(/\\/g, "/");
    const matcher = new Minimatch(normalized, { dot: true });
    const includeChildren = looksLikeDirectory(normalized);
    const recursive = includeChildren ? new Minimatch(`${normalized}/**`, { dot: true }) : undefined;
    return { base, glob: normalized, includeChildren, matcher, recursiveMatcher: recursive };
  }

  private async handleMutation(kind: FileMutationKind, uri: vscode.Uri, reason: string): Promise<void> {
    if (this.tagStates.size === 0) return;

    const changedTags = new Set<string>();
    const key = uri.toString();

    for (const state of this.tagStates.values()) {
      if (!state.loaded || state.compiled.length === 0) continue;

      const matches = this.matchesTag(state, uri);
      const had = state.uris.has(key);
      let updated = false;

      if (kind === "delete") {
        if (had) {
          state.uris.delete(key);
          updated = true;
        }
      } else {
        if (matches && !had) {
          state.uris.set(key, uri);
          updated = true;
        } else if (!matches && had) {
          state.uris.delete(key);
          updated = true;
        }
      }

      if (updated)
        changedTags.add(state.name);
    }

    if (changedTags.size === 0) return;
    await this.updateViewsForTags(changedTags, `${reason}:${kind}`);
  }

  private matchesTag(state: TagState, uri: vscode.Uri): boolean {
    for (const pattern of state.compiled) {
      const relative = this.relativeFrom(pattern.base, uri);
      if (!relative) continue;
      if (pattern.matcher.match(relative)) return true;
      if (pattern.recursiveMatcher && pattern.recursiveMatcher.match(relative)) return true;
    }
    return false;
  }

  private relativeFrom(base: vscode.Uri, target: vscode.Uri): string | undefined {
    const relative = path.relative(base.fsPath, target.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  }

  private async updateViewsForTags(tagNames: Set<string>, reason: string): Promise<void> {
    for (const view of this.viewStates.values()) {
      if (view.version === 0) continue;
      if (view.dependsOnTags.size === 0) continue;
      if (!this.setsIntersect(tagNames, view.dependsOnTags)) continue;
      await this.recomputeViewDiff(view, reason);
    }
  }

  private async recomputeViewDiff(view: ViewState, reason: string): Promise<void> {
    try {
      const map = await this.evaluateExpression(view.expr, { useCacheOnly: true, trace: `diff:${view.name}` });
      const added: vscode.Uri[] = [];
      const removed: vscode.Uri[] = [];

      for (const [key, uri] of map)
        if (!view.uris.has(key))
          added.push(uri);

      for (const [key, uri] of view.uris)
        if (!map.has(key))
          removed.push(uri);

      if (added.length === 0 && removed.length === 0) return;

      view.uris = map;
      view.version++;
      this._onDidUpdateViewEntries.fire({ view: view.name, added, removed, reason, version: view.version });

    } catch (error) {
      logTiming("FileTagEngine", `diff failed for ${view.name} | ${error instanceof Error ? error.message : String(error)}`);
      this._onDidRequireFullRefresh.fire({ view: view.name, reason: `diffError:${reason}` });
    }
  }

  private setsIntersect(a: Set<string>, b: Set<string>): boolean {
    for (const value of a)
      if (b.has(value))
        return true;
    return false;
  }

  private async evaluateExpression(expr: TagSetExpression, options: EvaluateOptions): Promise<UriMap> {
    switch (expr.kind) {
      case "tags":
        return this.evaluateTagsNode(expr.tags, options);
      case "union":
        return this.reduceUnion(expr.nodes, options);
      case "intersect":
        return this.reduceIntersect(expr.nodes, options);
      case "subtract":
        return this.subtract(expr.include, expr.exclude, options);
      case "fromExclude":
        return this.fromExclude(expr, options);
      case "all": {
        if (options.useCacheOnly)
          return new Map();
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(this.workspaceFolder, "**/*"),
        );
        return this.toUriMap(files);
      }
      default:
        return new Map();
    }
  }

  private async evaluateTagsNode(tags: string[], options: EvaluateOptions): Promise<UriMap> {
    if (tags.length === 0) return new Map();
    if (options.useCacheOnly) {
      return tags.reduce((acc, tag) => this.union(acc, this.getCachedTagUris(tag)), new Map<string, vscode.Uri>());
    }
    const sets = await Promise.all(tags.map(tag => this.getTagUris(tag, options)));
    return sets.reduce((acc, set) => this.union(acc, set), new Map<string, vscode.Uri>());
  }

  private async reduceUnion(nodes: TagSetExpression[], options: EvaluateOptions): Promise<UriMap> {
    const sets = await Promise.all(nodes.map(node => this.evaluateExpression(node, options)));
    return sets.reduce((acc, set) => this.union(acc, set), new Map<string, vscode.Uri>());
  }

  private async reduceIntersect(nodes: TagSetExpression[], options: EvaluateOptions): Promise<UriMap> {
    if (nodes.length === 0) return new Map();
    const [first, ...rest] = nodes;
    let result = await this.evaluateExpression(first, options);
    for (const node of rest) {
      if (result.size === 0) break;
      const next = await this.evaluateExpression(node, options);
      result = this.intersect(result, next);
    }
    return result;
  }

  private async subtract(includeExpr: TagSetExpression, excludeExpr: TagSetExpression, options: EvaluateOptions): Promise<UriMap> {
    const include = await this.evaluateExpression(includeExpr, options);
    if (include.size === 0) return include;
    const exclude = await this.evaluateExpression(excludeExpr, options);
    return this.difference(include, exclude);
  }

  private async fromExclude(expr: Extract<TagSetExpression, { kind: "fromExclude" }>, options: EvaluateOptions): Promise<UriMap> {
    const include = await this.evaluateTagsNode(expr.include, options);
    if (expr.exclude.length === 0 || include.size === 0)
      return include;
    const exclude = await this.evaluateTagsNode(expr.exclude, options);
    return this.difference(include, exclude);
  }

  private getCachedTagUris(tagName: string): UriMap {
    return this.tagStates.get(tagName)?.uris ?? new Map();
  }

  private async getTagUris(tagName: string, options: EvaluateOptions): Promise<UriMap> {
    const state = this.tagStates.get(tagName);
    if (!state) return new Map();
    if (!state.loaded || options.forceReloadTags)
      await this.reloadTagState(state, options.trace);
    return state.uris;
  }

  private async reloadTagState(state: TagState, trace?: string): Promise<void> {
    if (state.rawPatterns.length === 0) {
      state.uris = new Map();
      state.loaded = true;
      return;
    }
    const uris = await resolveTag(state.rawPatterns, this.workspaceFolder, trace ?? `tag:${state.name}`);
    state.uris = this.toUriMap(uris);
    state.loaded = true;
  }

  private toUriMap(uris: readonly vscode.Uri[]): UriMap {
    return new Map(uris.map(uri => [uri.toString(), uri]));
  }

  private union(a: UriMap, b: UriMap): UriMap {
    const result = new Map(a);
    for (const [key, value] of b)
      result.set(key, value);
    return result;
  }

  private intersect(a: UriMap, b: UriMap): UriMap {
    const result = new Map<string, vscode.Uri>();
    for (const [key, value] of a)
      if (b.has(key))
        result.set(key, value);
    return result;
  }

  private difference(a: UriMap, b: UriMap): UriMap {
    if (b.size === 0) return new Map(a);
    const result = new Map<string, vscode.Uri>();
    for (const [key, value] of a)
      if (!b.has(key))
        result.set(key, value);
    return result;
  }

  private tagGlobs(tagName: string): string[] {
    return this.tagStates.get(tagName)?.rawPatterns ?? [];
  }

  private collectGlobs(expr: TagSetExpression): { include: string[]; exclude: string[]; complex: boolean } {
    switch (expr.kind) {
      case "tags": {
        const include = expr.tags.flatMap(tag => this.tagGlobs(tag).map(stripVariablePrefix));
        return { include, exclude: [], complex: false };
      }
      case "fromExclude": {
        const include = expr.include.flatMap(tag => this.tagGlobs(tag).map(stripVariablePrefix));
        const exclude = expr.exclude.flatMap(tag => this.tagGlobs(tag).map(stripVariablePrefix));
        return { include, exclude, complex: false };
      }
      case "union": {
        const include: string[] = [];
        for (const node of expr.nodes) {
          const sub = this.collectGlobs(node);
          if (sub.complex || sub.exclude.length > 0)
            return { include: [], exclude: [], complex: true };
          include.push(...sub.include);
        }
        return { include, exclude: [], complex: false };
      }
      case "subtract": {
        const inc = this.collectGlobs(expr.include);
        const exc = this.collectGlobs(expr.exclude);
        if (inc.complex || exc.complex || inc.exclude.length > 0)
          return { include: [], exclude: [], complex: true };
        return { include: inc.include, exclude: [...exc.include, ...exc.exclude], complex: false };
      }
      default:
        return { include: [], exclude: [], complex: true };
    }
  }

  private async extractGlobs(expr: TagSetExpression): Promise<ExtractedGlobs> {
    const parts = this.collectGlobs(expr);
    if (!parts.complex)
      return {
        include: parts.include.join(", "),
        exclude: parts.exclude.join(", "),
      };

    const uris = await this.evaluateExpression(expr, { trace: "globs", forceReloadTags: true });
    const paths = Array.from(uris.values())
      .map(uri => vscode.workspace.asRelativePath(uri, false));
    const joined = paths.join(", ");

    if (joined.length > 10000) {
      const dirCounts = new Map<string, number>();
      for (const p of paths) {
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
      const compressed: string[] = [];
      const covered = new Set<string>();
      for (const [dir, count] of dirCounts)
        if (count >= 5) {
          compressed.push(`${dir}/**`);
          covered.add(dir);
        }
      for (const p of paths) {
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
        if (!covered.has(dir)) compressed.push(p);
      }
      return { include: compressed.join(", "), exclude: "" };
    }

    return { include: joined, exclude: "" };
  }

  private normalizeCondition(condition: ViewCondition | undefined): TagSetExpression | undefined {
    if (!condition) return { kind: "tags", tags: [] };

    if (typeof condition === "string")
      return { kind: "tags", tags: [condition] };

    if (Array.isArray(condition))
      return { kind: "tags", tags: condition };

    if ("union" in condition)
      return {
        kind: "union",
        nodes: (condition.union ?? [])
          .map(c => this.normalizeCondition(c))
          .filter((c): c is TagSetExpression => Boolean(c)),
      };

    if ("intersect" in condition)
      return {
        kind: "intersect",
        nodes: (condition.intersect ?? [])
          .map(c => this.normalizeCondition(c))
          .filter((c): c is TagSetExpression => Boolean(c)),
      };

    if ("subtract" in condition) {
      const include = this.normalizeCondition(condition.subtract.include);
      const exclude = this.normalizeCondition(condition.subtract.exclude);
      if (include && exclude)
        return { kind: "subtract", include, exclude };
      return include ?? exclude ?? { kind: "tags", tags: [] };
    }

    if ("from" in condition) {
      return {
        kind: "fromExclude",
        include: this.toTagArray(condition.from),
        exclude: this.toTagArray(condition.exclude ?? []),
      };
    }

    if ("and" in condition)
      return {
        kind: "intersect",
        nodes: (condition.and ?? [])
          .map(c => this.normalizeCondition(c))
          .filter((c): c is TagSetExpression => Boolean(c)),
      };

    if ("or" in condition)
      return {
        kind: "union",
        nodes: (condition.or ?? [])
          .map(c => this.normalizeCondition(c))
          .filter((c): c is TagSetExpression => Boolean(c)),
      };

    if ("not" in condition) {
      const exclude = this.normalizeCondition(condition.not);
      if (!exclude) return { kind: "all" };
      return { kind: "subtract", include: { kind: "all" }, exclude };
    }

    return undefined;
  }

  private collectDependencies(expr: TagSetExpression, acc: Set<string> = new Set()): Set<string> {
    switch (expr.kind) {
      case "tags":
        for (const tag of expr.tags) acc.add(tag);
        break;
      case "fromExclude":
        for (const tag of expr.include) acc.add(tag);
        for (const tag of expr.exclude) acc.add(tag);
        break;
      case "union":
      case "intersect":
        for (const node of expr.nodes)
          this.collectDependencies(node, acc);
        break;
      case "subtract":
        this.collectDependencies(expr.include, acc);
        this.collectDependencies(expr.exclude, acc);
        break;
      default:
        break;
    }
    return acc;
  }

  private toTagArray(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
  }
}
