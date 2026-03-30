import * as vscode from "vscode";
import {
  resolveTag,
  stripVariablePrefix,
} from "./resolver";
import {
  FileTagConfig,
  ViewCondition,
  ExtractedGlobs,
} from "./types";


type UriSet = Set<string>;

// Promise-based cache: ensures concurrent requests for the same tag share
// a single findFiles call instead of issuing duplicates.
type UriCache = Map<string, Promise<UriSet>>;


function union(a: UriSet, b: UriSet): UriSet {
  const result = new Set(a);
  for (const item of b) result.add(item);
  return result;
}


function intersect(a: UriSet, b: UriSet): UriSet {
  const result = new Set<string>();
  for (const item of a) if (b.has(item)) result.add(item);
  return result;
}


function difference(a: UriSet, b: UriSet): UriSet {
  const result = new Set<string>();
  for (const item of a) if (!b.has(item)) result.add(item);
  return result;
}


function toUriSet(uris: readonly vscode.Uri[]): UriSet {
  return new Set(uris.map(u => u.toString()));
}


function isNotCondition(c: ViewCondition): c is { not: ViewCondition } {
  return typeof c === "object" && !Array.isArray(c) && "not" in c;
}


function resolveTagCached(
  tagName: string,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  cache: UriCache,
): Promise<UriSet> {
  if (!cache.has(tagName)) {
    const promise = (async (): Promise<UriSet> => {
      const patterns = config.tags[tagName];
      if (!patterns) return new Set();
      return toUriSet(await resolveTag(patterns, workspaceFolder));
    })();
    cache.set(tagName, promise);
  }
  return cache.get(tagName)!;
}


async function evaluateInner(
  condition: ViewCondition,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  cache: UriCache,
): Promise<UriSet> {
  if (typeof condition === "string")
    return resolveTagCached(condition, config, workspaceFolder, cache);

  if (Array.isArray(condition)) {
    const sets = await Promise.all(
      condition.map(t => resolveTagCached(t, config, workspaceFolder, cache)));
    return sets.reduce(union, new Set<string>());
  }

  if ("or" in condition) {
    const sets = await Promise.all(
      condition.or.map(c => evaluateInner(c, config, workspaceFolder, cache)));
    return sets.reduce(union, new Set<string>());
  }

  if ("and" in condition) {
    // Separate positive conditions from {not} conditions so we never need
    // the universal set — negatives become simple set-differences on the
    // already-computed positive result.
    const positives = condition.and.filter(c => !isNotCondition(c));
    const notInners = condition.and.filter(isNotCondition).map(c => c.not);

    const [posSets, negSets] = await Promise.all([
      Promise.all(positives.map(c => evaluateInner(c, config, workspaceFolder, cache))),
      Promise.all(notInners.map(c => evaluateInner(c, config, workspaceFolder, cache))),
    ]);

    let result: UriSet = posSets.length > 0
      ? posSets.reduce(intersect)
      : new Set();

    for (const neg of negSets)
      result = difference(result, neg);

    return result;
  }

  if ("not" in condition) {
    // Bare {not} without an enclosing {and}: unavoidable universe query.
    const [excludeSet, allFiles] = await Promise.all([
      evaluateInner(condition.not, config, workspaceFolder, cache),
      vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, "**/*")),
    ]);
    return difference(toUriSet(allFiles), excludeSet);
  }

  return new Set();
}


export async function evaluateCondition(
  condition: ViewCondition,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
  const cache: UriCache = new Map();
  const resultSet = await evaluateInner(condition, config, workspaceFolder, cache);
  return Array.from(resultSet).map(s => vscode.Uri.parse(s));
}


// --- Glob extraction for search-in-view ---
interface GlobParts {
  include: string[];
  exclude: string[];
  complex: boolean;
}


function getTagGlobs(tagName: string, config: FileTagConfig): string[] {
  const patterns = config.tags[tagName];
  if (!patterns) return [];
  return patterns.map(stripVariablePrefix);
}


function extractGlobsInner(condition: ViewCondition, config: FileTagConfig): GlobParts {
  if (typeof condition === "string")
    return { include: getTagGlobs(condition, config), exclude: [], complex: false };

  if (Array.isArray(condition)) {
    const include: string[] = [];
    for (const tagName of condition)
      include.push(...getTagGlobs(tagName, config));
    return { include, exclude: [], complex: false };
  }

  if ("or" in condition) {
    const include: string[] = [];
    let complex = false;
    for (const child of condition.or) {
      const sub = extractGlobsInner(child, config);
      if (sub.complex || sub.exclude.length > 0) { complex = true; break; }
      include.push(...sub.include);
    }
    return complex ? { include: [], exclude: [], complex: true } : { include, exclude: [], complex: false };
  }

  if ("and" in condition) {
    const positiveIncludes: string[] = [];
    const negativeExcludes: string[] = [];
    let complex = false;
    for (const child of condition.and) {
      if (isNotCondition(child)) {
        const notInner = extractGlobsInner(child.not, config);
        if (notInner.complex || notInner.exclude.length > 0) { complex = true; break; }
        negativeExcludes.push(...notInner.include);
        continue;
      }
      const sub = extractGlobsInner(child, config);
      if (sub.complex) { complex = true; break; }
      positiveIncludes.push(...sub.include);
      negativeExcludes.push(...sub.exclude);
    }
    return complex
      ? { include: [], exclude: [], complex: true }
      : { include: positiveIncludes, exclude: negativeExcludes, complex: false };
  }

  if ("not" in condition) {
    const inner = extractGlobsInner(condition.not, config);
    return inner.complex
      ? { include: [], exclude: [], complex: true }
      : { include: [], exclude: inner.include, complex: false };
  }

  return { include: [], exclude: [], complex: true };
}


export async function extractGlobs(
  condition: ViewCondition,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<ExtractedGlobs> {
  const parts = extractGlobsInner(condition, config);

  if (!parts.complex)
    return {
      include: parts.include.join(", "),
      exclude: parts.exclude.join(", "),
    };

  // Fallback: resolve URIs and convert to relative paths
  const uris = await evaluateCondition(condition, config, workspaceFolder);
  const paths = uris.map(uri => vscode.workspace.asRelativePath(uri, false));
  const joined = paths.join(", ");

  if (joined.length > 10000) {
    const dirCounts = new Map<string, number>();
    for (const p of paths) {
      const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : ".";
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const compressed: string[] = [];
    const coveredDirs = new Set<string>();
    for (const [dir, count] of dirCounts)
      if (count >= 5) { compressed.push(`${dir}/**`); coveredDirs.add(dir); }
    for (const p of paths) {
      const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : ".";
      if (!coveredDirs.has(dir)) compressed.push(p);
    }
    return { include: compressed.join(", "), exclude: "" };
  }

  return { include: joined, exclude: "" };
}
