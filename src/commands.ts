import * as vscode from "vscode";
import { extractGlobs } from "./evaluator";
import { ConfigManager } from "./config";
import { FileTagTreeDataProvider, TreeNode, DirNode } from "./treeDataProvider";


const LAST_VIEW_KEY = "fileTag.lastView";
const WORKSPACE_FOLDER_PREFIX = "{WORKSPACE_FOLDER}/";

// Internal clipboard for copy/paste file operations
let copyClipboard: vscode.Uri | undefined;

function nodeUri(node: TreeNode, workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  if (node.kind === "file") return node.uri;
  return vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
}

async function findFreeCopyUri(uri: vscode.Uri): Promise<vscode.Uri> {
  const name = uri.path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot)    : "";
  const parent = vscode.Uri.joinPath(uri, "..");

  let candidate = vscode.Uri.joinPath(parent, `${base} copy${ext}`);
  let n = 2;
  while (true) {
    try {
      await vscode.workspace.fs.stat(candidate);
      candidate = vscode.Uri.joinPath(parent, `${base} copy ${n}${ext}`);
      n++;
    } catch {
      return candidate;
    }
  }
}


export function registerCommands(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  treeDataProvider: FileTagTreeDataProvider,
  treeView: vscode.TreeView<TreeNode>,
  workspaceFolder: vscode.WorkspaceFolder,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("fileTag.createTag", async () => {
      const config = await configManager.read();
      const name = await vscode.window.showInputBox({
        prompt: "Enter tag name",
        validateInput: (value) => {
          if (!value.trim())
            return "Tag name cannot be empty";
          if (config.tags[value.trim()])
            return `Tag "${value.trim()}" already exists`;
          return undefined;
        },
      });
      if (!name) return;

      config.tags[name.trim()] = [];
      await configManager.write(config);
      vscode.window.showInformationMessage(`Tag "${name.trim()}" created.`);
    }),

    vscode.commands.registerCommand("fileTag.addFiles", async () => {
      const config = await configManager.read();
      const tagNames = Object.keys(config.tags);
      if (tagNames.length === 0) {
        vscode.window.showWarningMessage("No tags exist. Create a tag first.");
        return;
      }

      // Pre-fill with currently focused file, or just the prefix if none
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const defaultValue = activeUri
        ? WORKSPACE_FOLDER_PREFIX + vscode.workspace.asRelativePath(activeUri, false)
        : WORKSPACE_FOLDER_PREFIX;

      const pattern = await vscode.window.showInputBox({
        prompt: "Enter file pattern (supports wildcards)",
        value: defaultValue,
        valueSelection: [defaultValue.length, defaultValue.length]
      });
      if (!pattern) return;

      const targetTag = await vscode.window.showQuickPick(tagNames,
        { placeHolder: "Select tag to add pattern to" });
      if (!targetTag) return;

      config.tags[targetTag].push(pattern);
      await configManager.write(config);
      vscode.window.showInformationMessage(
        `Added pattern to "${targetTag}".`);
    }),

    // Shared: activate a view by name (used by tree item click and QuickPick)
    vscode.commands.registerCommand("fileTag.openView", async (viewName: string) => {
      await treeDataProvider.selectView(viewName);
      treeView.title = viewName;
      context.workspaceState.update(LAST_VIEW_KEY, viewName);
    }),

    vscode.commands.registerCommand("fileTag.selectView", async () => {
      await treeDataProvider.clearView();
      treeView.title = "File Tag";
      context.workspaceState.update(LAST_VIEW_KEY, undefined);
    }),

    vscode.commands.registerCommand("fileTag.searchInView", async () => {
      const viewName = treeDataProvider.getCurrentViewName();
      if (!viewName) {
        vscode.window.showWarningMessage("No view selected. Select a view first.");
        return;
      }

      const config = await configManager.read();
      const condition = config.views[viewName];
      if (!condition) {
        vscode.window.showWarningMessage(`View "${viewName}" not found in config.`);
        return;
      }

      const globs = await extractGlobs(condition, config, workspaceFolder);
      if (!globs.include && !globs.exclude) {
        vscode.window.showInformationMessage("View resolves to no files.");
        return;
      }

      await vscode.commands.executeCommand("workbench.action.findInFiles", {
        filesToInclude: globs.include,
        filesToExclude: globs.exclude,
        triggerSearch: false,
      });
    }),

    vscode.commands.registerCommand("fileTag.openConfig", async () => {
      await configManager.ensureExists();
      const doc = await vscode.workspace.openTextDocument(configManager.getConfigUri());
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("fileTag.newView", async () => {
      const config = await configManager.read();
      const tagNames = Object.keys(config.tags);
      if (tagNames.length === 0) {
        vscode.window.showWarningMessage("No tags defined. Create some tags first.");
        return;
      }

      const selected = await vscode.window.showQuickPick(
        tagNames.map(name => ({ label: name })),
        { canPickMany: true, placeHolder: "Select tags to include (union)" },
      );
      if (!selected || selected.length === 0) return;

      const viewName = await vscode.window.showInputBox({
        prompt: "Enter view name",
        validateInput: (value) => {
          if (!value.trim()) return "View name cannot be empty";
          if (config.views[value.trim()]) return `View "${value.trim()}" already exists`;
          return undefined;
        },
      });
      if (!viewName) return;

      const name = viewName.trim();
      const condition = selected.length === 1
        ? selected[0].label
        : selected.map(s => s.label);

      config.views[name] = condition;
      await configManager.write(config);
      await vscode.commands.executeCommand("fileTag.openView", name);
    }),

    vscode.commands.registerCommand("fileTag.deleteView", async (node: TreeNode) => {
      if (node.kind !== "viewList") return;
      const answer = await vscode.window.showWarningMessage(
        `Delete view "${node.name}"?`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") return;

      const config = await configManager.read();
      delete config.views[node.name];
      await configManager.write(config);

      if (treeDataProvider.getCurrentViewName() === node.name) {
        await treeDataProvider.clearView();
        treeView.title = "File Tag";
        context.workspaceState.update(LAST_VIEW_KEY, undefined);
      }
    }),

    vscode.commands.registerCommand("fileTag.refreshView", async () => {
      await treeDataProvider.refresh();
    }),

    vscode.commands.registerCommand("fileTag.collapseAll", () => {
      vscode.commands.executeCommand("workbench.actions.treeView.fileTagView.collapseAll");
    }),

    vscode.commands.registerCommand("fileTag.clearLastView", async () => {
      await context.workspaceState.update(LAST_VIEW_KEY, undefined);
      vscode.window.showInformationMessage("Last view cleared. Reload the window to see the view list.");
    }),

    // --- File / directory context menu actions ---

    vscode.commands.registerCommand("fileTag.openToSide", async (node: TreeNode) => {
      if (node.kind !== "file") return;
      await vscode.commands.executeCommand("vscode.open", node.uri, { viewColumn: vscode.ViewColumn.Beside });
    }),

    vscode.commands.registerCommand("fileTag.revealInExplorer", async (node: TreeNode) => {
      const uri = node.kind === "file" ? node.uri
        : vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }),

    vscode.commands.registerCommand("fileTag.revealInOS", async (node: TreeNode) => {
      const uri = node.kind === "file" ? node.uri
        : vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    }),

    vscode.commands.registerCommand("fileTag.openInTerminal", async (node: TreeNode) => {
      const uri = node.kind === "file"
        ? vscode.Uri.joinPath(node.uri, "..")
        : vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
      vscode.window.createTerminal({ cwd: uri }).show();
    }),

    vscode.commands.registerCommand("fileTag.copyPath", async (node: TreeNode) => {
      const uri = node.kind === "file" ? node.uri
        : vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
      await vscode.env.clipboard.writeText(uri.fsPath);
    }),

    vscode.commands.registerCommand("fileTag.copyRelativePath", async (node: TreeNode) => {
      const uri = node.kind === "file" ? node.uri
        : vscode.Uri.joinPath(workspaceFolder.uri, (node as DirNode).relativePath);
      await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(uri, false));
    }),

    vscode.commands.registerCommand("fileTag.copyFile", async (node: TreeNode) => {
      copyClipboard = nodeUri(node, workspaceFolder);
      vscode.commands.executeCommand("setContext", "fileTag.clipboardHasFile", true);
    }),

    vscode.commands.registerCommand("fileTag.pasteFile", async (node: TreeNode) => {
      if (!copyClipboard) return;
      const dirUri = nodeUri(node, workspaceFolder);
      const fileName = copyClipboard.path.split("/").pop()!;
      const targetUri = vscode.Uri.joinPath(dirUri, fileName);
      try {
        await vscode.workspace.fs.copy(copyClipboard, targetUri, { overwrite: false });
        await treeDataProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Paste failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand("fileTag.duplicateFile", async (node: TreeNode) => {
      const uri = nodeUri(node, workspaceFolder);
      const newUri = await findFreeCopyUri(uri);
      try {
        await vscode.workspace.fs.copy(uri, newUri, { overwrite: false });
        await treeDataProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Duplicate failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand("fileTag.renameFile", async (node: TreeNode) => {
      const uri = nodeUri(node, workspaceFolder);
      const dot = node.name.lastIndexOf(".");
      const selEnd = node.kind === "file" && dot > 0 ? dot : node.name.length;
      const newName = await vscode.window.showInputBox({
        prompt: "New name",
        value: node.name,
        valueSelection: [0, selEnd],
        validateInput: v => v.includes("/") || v.includes("\\") ? "Name cannot contain path separators" : undefined,
      });
      if (!newName || newName === node.name) return;
      const newUri = vscode.Uri.joinPath(uri, "..", newName);
      try {
        await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
        await treeDataProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Rename failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand("fileTag.deleteFile", async (node: TreeNode) => {
      const uri = nodeUri(node, workspaceFolder);
      const answer = await vscode.window.showWarningMessage(
        `Delete "${node.name}"?`,
        { modal: true },
        "Move to Trash",
      );
      if (answer !== "Move to Trash") return;
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
        await treeDataProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Delete failed: ${e}`);
      }
    }),
  );
}
