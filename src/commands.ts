import * as vscode from "vscode";
import { extractGlobs } from "./evaluator";
import { ConfigManager } from "./config";
import { FileTagTreeDataProvider, TreeNode } from "./treeDataProvider";


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

    vscode.commands.registerCommand("fileTag.selectView", async () => {
      const config = await configManager.read();
      const viewNames = Object.keys(config.views);
      if (viewNames.length === 0) {
        vscode.window.showInformationMessage(
          "No views defined. Add views in the config file.");
        return;
      }

      const picked = await vscode.window.showQuickPick(viewNames,
        { placeHolder: "Select a view" });
      if (!picked) return;

      await treeDataProvider.selectView(picked);
      treeView.description = picked;
      context.workspaceState.update("fileTag.lastView", picked);
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

    vscode.commands.registerCommand("fileTag.refreshView", async () => {
      await treeDataProvider.refresh();
    }),
  );
}
