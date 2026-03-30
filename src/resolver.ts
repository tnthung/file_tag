import * as os from "os";
import * as vscode from "vscode";


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


export async function resolveTag(
  patterns: string[],
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
  const seen = new Map<string, vscode.Uri>();

  for (const pattern of patterns) {
    const { base, glob } = parsePattern(pattern, workspaceFolder);
    const relativePattern = new vscode.RelativePattern(base, glob);
    for (const uri of await vscode.workspace.findFiles(relativePattern))
      seen.set(uri.toString(), uri);
  }

  return Array.from(seen.values());
}


/** Strips any recognised variable prefix, returning the bare glob string. */
export function stripVariablePrefix(pattern: string): string {
  return parsePattern(pattern, { uri: vscode.Uri.file(""), name: "", index: 0 }).glob;
}
