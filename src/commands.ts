import * as vscode from "vscode";
import { extractGlobs } from "./evaluator";
import { ConfigManager } from "./config";
import { FileTagTreeDataProvider, TreeNode } from "./treeDataProvider";


const LAST_VIEW_KEY = "fileTag.lastView";
const WORKSPACE_FOLDER_PREFIX = "{WORKSPACE_FOLDER}/";



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

    vscode.commands.registerCommand("fileTag.refreshView", async () => {
      await treeDataProvider.refresh();
    }),

    vscode.commands.registerCommand("fileTag.clearLastView", async () => {
      await context.workspaceState.update(LAST_VIEW_KEY, undefined);
      vscode.window.showInformationMessage("Last view cleared. Reload the window to see the view list.");
    }),
  );
}
