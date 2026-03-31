import * as os from "os";
import * as vscode from "vscode";
import { performance } from "perf_hooks";
import {
  TimingLog,
  logTiming,
} from "./timing";


/**
 * Resolves a pattern's base and the remaining glob relative to that base.
 *
 * Supported variables (VS Code standard syntax):
 *   ${workspaceFolder}          – first/only workspace folder
 *   ${workspaceFolder:Name}     – named workspace folder (multi-root)
 *   ${userHome}                 – user home directory
 *   ${env:VAR}                  – environment variable (must be an absolute path)
 *
 * Patterns without a variable prefix are treated as workspace-relative.
 */
function parsePattern(
  pattern: string,
  workspaceFolder: vscode.WorkspaceFolder,
): { base: vscode.Uri; glob: string } {
  // ${workspaceFolder}/...
  const wsMatch = pattern.match(/^\$\{workspaceFolder(?::([^}]+))?\}\/(.*)$/);
  if (wsMatch) {
    const name = wsMatch[1];
    const glob = wsMatch[2];
    if (name) {
      const folder = vscode.workspace.workspaceFolders?.find(f => f.name === name);
      const base = folder?.uri ?? workspaceFolder.uri;
      return { base, glob };
    }
    return { base: workspaceFolder.uri, glob };
  }

  // ${userHome}/...
  const homeMatch = pattern.match(/^\$\{userHome\}\/(.*)$/);
  if (homeMatch)
    return { base: vscode.Uri.file(os.homedir()), glob: homeMatch[1] };

  // ${env:VAR}/...
  const envMatch = pattern.match(/^\$\{env:([^}]+)\}\/(.*)$/);
  if (envMatch) {
    const value = process.env[envMatch[1]];
    if (value)
      return { base: vscode.Uri.file(value), glob: envMatch[2] };
  }

  // No recognised prefix — treat as workspace-relative
  return { base: workspaceFolder.uri, glob: pattern };
}


// Returns true if a glob's last segment looks like a plain directory name
// (no glob characters, no file extension). Such patterns are also searched
// with "/**" appended so that directory contents are included.
// e.g. "**/node_modules" -> also search "**/node_modules/**"
function looksLikeDirectory(glob: string): boolean {
  const last = glob.split("/").pop() ?? "";
  return last.length > 0
    && !last.includes("*")
    && !last.includes("?")
    && !last.includes("{")
    && !last.includes(".");
}


export async function resolveTag(
  patterns: string[],
  workspaceFolder: vscode.WorkspaceFolder,
  traceLabel = "resolveTag",
): Promise<vscode.Uri[]> {
  const timing = new TimingLog(traceLabel);
  const seen = new Map<string, vscode.Uri>();

  const allUris = await Promise.all(patterns.map(async pattern => {
    const startedAt = performance.now();
    const { base, glob } = parsePattern(pattern, workspaceFolder);
    const searches = [
      Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(base, glob))),
    ];
    // If the last segment looks like a directory, also search inside it
    if (looksLikeDirectory(glob))
      searches.push(Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(base, glob + "/**"))));
    const uris = (await Promise.all(searches)).flat();
    logTiming(traceLabel, `pattern ${JSON.stringify(pattern)}: ${(performance.now() - startedAt).toFixed(1)} ms | ${uris.length} matches`);
    return uris;
  }));

  timing.step("resolve patterns", `${patterns.length} patterns`);

  for (const uris of allUris)
    for (const uri of uris)
      seen.set(uri.toString(), uri);

  timing.step("dedupe matches", `${seen.size} unique files`);
  timing.end();
  return Array.from(seen.values());
}


/** Strips any recognised variable prefix, returning the bare glob string. */
export function stripVariablePrefix(pattern: string): string {
  return parsePattern(pattern, { uri: vscode.Uri.file(""), name: "", index: 0 }).glob;
}
