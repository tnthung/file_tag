import * as vscode from "vscode";


const WORKSPACE_FOLDER_PREFIX = "{WORKSPACE_FOLDER}/";


export function stripWorkspacePrefix(pattern: string): string {
  if (pattern.startsWith(WORKSPACE_FOLDER_PREFIX))
    return pattern.slice(WORKSPACE_FOLDER_PREFIX.length);
  return pattern;
}


export async function resolveTag(
  patterns: string[],
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri[]> {
  const seen = new Map<string, vscode.Uri>();

  for (const pattern of patterns) {
    const relative = stripWorkspacePrefix(pattern);
    const relativePattern = new vscode.RelativePattern(workspaceFolder, relative);
    for (const uri of await vscode.workspace.findFiles(relativePattern))
      seen.set(uri.toString(), uri);
  }

  return Array.from(seen.values());
}
