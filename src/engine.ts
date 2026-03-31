import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { resolveTag, stripVariablePrefix } from "./resolver";
import { TimingLog, logTiming } from "./timing";
import {
  ExtractedGlobs,
  FileTagConfig,
  TagSetExpression,
  ViewCondition,
} from "./types";


type UriMap = Map<string, vscode.Uri>;


interface EvaluateOptions {
  trace?: string;
}


interface GlobParts {
  include: string[];
  exclude: string[];
  complex: boolean;
}


export class FileTagEngine implements vscode.Disposable {
  private config: FileTagConfig | undefined;
  private viewExpressions = new Map<string, TagSetExpression>();
  private tagPatterns = new Map<string, string[]>();
  private tagCache = new Map<string, Promise<UriMap>>();
  private disposables: vscode.Disposable[] = [];
  private fsWatcher: vscode.FileSystemWatcher | undefined;
  private readonly _onDidInvalidate = new vscode.EventEmitter<void>();
  readonly onDidInvalidate = this._onDidInvalidate.event;

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
        this._onDidInvalidate.fire();
      }),
    );

    this.setupWorkspaceWatcher();
  }

  dispose(): void {
    this.tagCache.clear();
    this.viewExpressions.clear();
    this.tagPatterns.clear();
    this.fsWatcher?.dispose();
    this.fsWatcher = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidInvalidate.dispose();
  }

  getConfig(): FileTagConfig | undefined {
    return this.config;
  }

  async evaluateView(viewName: string): Promise<vscode.Uri[]> {
    const expr = this.viewExpressions.get(viewName);
    if (!expr) return [];

    const timing = new TimingLog(`evaluateView(${viewName})`);
    try {
      const map = await this.evaluateExpression(expr, { trace: `view:${viewName}` });
      timing.step("resolve expression", `${map.size} files`);
      const uris = Array.from(map.values());
      timing.step("materialize uris", `${uris.length} files`);
      timing.end();
      return uris;
    } catch (error) {
      timing.fail(error);
      throw error;
    }
  }

  async evaluateTags(tagNames: string[], traceLabel: string): Promise<vscode.Uri[]> {
    const timing = new TimingLog(traceLabel);
    try {
      const expr: TagSetExpression = { kind: "tags", tags: tagNames };
      const map = await this.evaluateExpression(expr, { trace: traceLabel });
      timing.step("resolve tags", `${map.size} files`);
      const uris = Array.from(map.values());
      timing.step("materialize uris", `${uris.length} files`);
      timing.end();
      return uris;
    } catch (error) {
      timing.fail(error);
      throw error;
    }
  }

  async getSearchGlobs(viewName: string): Promise<ExtractedGlobs> {
    const expr = this.viewExpressions.get(viewName);
    if (!expr) return { include: "", exclude: "" };
    return this.extractGlobs(expr);
  }

  private setupWorkspaceWatcher(): void {
    this.fsWatcher?.dispose();
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, "**/*"),
    );

    const invalidate = () => {
      this.tagCache.clear();
      logTiming("FileTagEngine", "workspace change detected; invalidated tag cache");
      this._onDidInvalidate.fire();
    };

    this.disposables.push(
      this.fsWatcher,
      this.fsWatcher.onDidChange(invalidate),
      this.fsWatcher.onDidCreate(invalidate),
      this.fsWatcher.onDidDelete(invalidate),
    );
  }

  private async reloadConfig(): Promise<void> {
    this.config = await this.configManager.read();
    this.tagCache.clear();
    this.viewExpressions.clear();
    this.tagPatterns.clear();

    if (!this.config) {
      return;
    }

    for (const [name, patterns] of Object.entries(this.config.tags))
      this.tagPatterns.set(name, patterns ?? []);

    for (const [name, condition] of Object.entries(this.config.views)) {
      const expr = this.normalizeCondition(condition);
      if (expr) this.viewExpressions.set(name, expr);
    }
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

  private toTagArray(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
  }

  private async evaluateExpression(expr: TagSetExpression, options: EvaluateOptions): Promise<UriMap> {
    switch (expr.kind) {
      case "tags":
        return this.evaluateTagsNode(expr.tags, options.trace);
      case "union":
        return this.reduceUnion(expr.nodes, options.trace);
      case "intersect":
        return this.reduceIntersect(expr.nodes, options.trace);
      case "subtract":
        return this.subtract(expr.include, expr.exclude, options.trace);
      case "fromExclude":
        return this.fromExclude(expr, options.trace);
      case "all": {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(this.workspaceFolder, "**/*"),
        );
        return this.toUriMap(files);
      }
      default:
        return new Map();
    }
  }

  private async evaluateTagsNode(tags: string[], trace?: string): Promise<UriMap> {
    if (tags.length === 0) return new Map();
    const sets = await Promise.all(tags.map(tag => this.resolveTagCached(tag, trace)));
    return sets.reduce((acc, set) => this.union(acc, set), new Map<string, vscode.Uri>());
  }

  private async reduceUnion(nodes: TagSetExpression[], trace?: string): Promise<UriMap> {
    const sets = await Promise.all(nodes.map(node => this.evaluateExpression(node, { trace })));
    return sets.reduce((acc, set) => this.union(acc, set), new Map<string, vscode.Uri>());
  }

  private async reduceIntersect(nodes: TagSetExpression[], trace?: string): Promise<UriMap> {
    if (nodes.length === 0) return new Map();
    const [first, ...rest] = nodes;
    let result = await this.evaluateExpression(first, { trace });
    for (const node of rest) {
      if (result.size === 0) break;
      const next = await this.evaluateExpression(node, { trace });
      result = this.intersect(result, next);
    }
    return result;
  }

  private async subtract(includeExpr: TagSetExpression, excludeExpr: TagSetExpression, trace?: string): Promise<UriMap> {
    const include = await this.evaluateExpression(includeExpr, { trace });
    if (include.size === 0) return include;
    const exclude = await this.evaluateExpression(excludeExpr, { trace });
    return this.difference(include, exclude);
  }

  private async fromExclude(expr: Extract<TagSetExpression, { kind: "fromExclude" }>, trace?: string): Promise<UriMap> {
    const include = await this.evaluateTagsNode(expr.include, trace);
    if (expr.exclude.length === 0 || include.size === 0)
      return include;
    const exclude = await this.evaluateTagsNode(expr.exclude, trace);
    return this.difference(include, exclude);
  }

  private async resolveTagCached(tagName: string, trace?: string): Promise<UriMap> {
    if (!this.tagCache.has(tagName)) {
      const promise = (async () => {
        const patterns = this.tagPatterns.get(tagName);
        if (!patterns || patterns.length === 0) return new Map<string, vscode.Uri>();
        const uris = await resolveTag(patterns, this.workspaceFolder, `tag:${tagName}`);
        return this.toUriMap(uris);
      })();
      this.tagCache.set(tagName, promise);
    }
    return this.tagCache.get(tagName)!;
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
    return this.tagPatterns.get(tagName) ?? [];
  }

  private collectGlobs(expr: TagSetExpression): GlobParts {
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

    const uris = await this.evaluateExpression(expr, { trace: "globs" });
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
}
