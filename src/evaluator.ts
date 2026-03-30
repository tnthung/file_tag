import * as vscode from "vscode";
import {
  resolveTag,
  stripWorkspacePrefix,
} from "./resolver";
import {
  FileTagConfig,
  ViewCondition,
  ExtractedGlobs,
} from "./types";


type UriSet = Set<string>;


function union(a: UriSet, b: UriSet): UriSet {
  const result = new Set(a);
  for (const item of b)
    result.add(item);
  return result;
}


function intersect(a: UriSet, b: UriSet): UriSet {
  const result = new Set<string>();
  for (const item of a)
    if (b.has(item))
      result.add(item);
  return result;
}


function difference(a: UriSet, b: UriSet): UriSet {
  const result = new Set<string>();
  for (const item of a)
    if (!b.has(item))
      result.add(item);
  return result;
}


function toUriSet(uris: vscode.Uri[]): UriSet {
  return new Set(uris.map(u => u.toString()));
}


async function resolveTagCached(
  tagName: string,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  cache: Map<string, UriSet>,
): Promise<UriSet> {
  const cached = cache.get(tagName);
  if (cached) return cached;

  const patterns = config.tags[tagName];
  if (!patterns) {
    const empty = new Set<string>();
    cache.set(tagName, empty);
    return empty;
  }

  const uris = await resolveTag(patterns, workspaceFolder);
  const set = toUriSet(uris);
  cache.set(tagName, set);
  return set;
}


async function evaluateInner(
  condition: ViewCondition,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  cache: Map<string, UriSet>,
): Promise<UriSet> {
  if (typeof condition === "string")
    return resolveTagCached(condition, config, workspaceFolder, cache);


  if (Array.isArray(condition)) {
    let result = new Set<string>();

    for (const tagName of condition) {
      const set = await evaluateInner(tagName, config, workspaceFolder, cache);
      result = union(result, set);
    }

    return result;
  }

  if ("or" in condition) {
    let result = new Set<string>();

    for (const child of condition.or) {
      const set = await evaluateInner(child, config, workspaceFolder, cache);
      result = union(result, set);
    }

    return result;
  }

  if ("and" in condition) {
    let result: UriSet | undefined;

    for (const child of condition.and) {
      const set = await evaluateInner(child, config, workspaceFolder, cache);
      result = result === undefined ? set : intersect(result, set);
    }

    return result ?? new Set();
  }

  if ("not" in condition) {
    const excludeSet = await evaluateInner(condition.not, config, workspaceFolder, cache);
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, "**/*"));
    const universalSet = toUriSet(allFiles);
    return difference(universalSet, excludeSet);
  }

  return new Set();
}


export async function evaluateCondition(
  condition: ViewCondition,
  config: FileTagConfig,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
  const cache = new Map<string, UriSet>();
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
  return patterns.map(stripWorkspacePrefix);
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
      if (sub.complex || sub.exclude.length > 0) {
        complex = true;
        break;
      }

      include.push(...sub.include);
    }

    return complex ? { include: [], exclude: [], complex: true } : { include, exclude: [], complex: false };
  }

  if ("and" in condition) {
    // Special case: positive parts AND NOT parts
    const positiveIncludes: string[] = [];
    const negativeExcludes: string[] = [];
    let complex = false;

    for (const child of condition.and) {
      if (typeof child === "object" && !Array.isArray(child) && "not" in child) {
        const notInner = extractGlobsInner(child.not, config);
        if (notInner.complex || notInner.exclude.length > 0) {
          complex = true;
          break;
        }

        negativeExcludes.push(...notInner.include);
        continue;
      }

      const sub = extractGlobsInner(child, config);
      if (sub.complex) {
        complex = true;
        break;
      }

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
  const paths = uris.map((uri) => vscode.workspace.asRelativePath(uri, false));
  const joined = paths.join(", ");

  if (joined.length > 10000) {
    // Compress by grouping into directory globs
    const dirCounts = new Map<string, number>();
    for (const p of paths) {
      const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : ".";
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    const compressed: string[] = [];
    const coveredDirs = new Set<string>();
    for (const [dir, count] of dirCounts)
      if (count >= 5) {
        compressed.push(`${dir}/**`);
        coveredDirs.add(dir);
      }

    for (const p of paths) {
      const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : ".";
      if (!coveredDirs.has(dir)) compressed.push(p);
    }

    return { include: compressed.join(", "), exclude: "" };
  }

  return { include: joined, exclude: "" };
}
