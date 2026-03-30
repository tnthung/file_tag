import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { registerCommands } from "./commands";
import { FileTagTreeDataProvider, TreeNode } from "./treeDataProvider";


export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;

  const workspaceFolder = workspaceFolders[0];
  const configManager = new ConfigManager(workspaceFolder);
  const treeDataProvider = new FileTagTreeDataProvider(configManager, workspaceFolder);

  const treeView = vscode.window.createTreeView<TreeNode>("fileTagView", {
    treeDataProvider,
  });

  registerCommands(context, configManager, treeDataProvider, treeView, workspaceFolder);

  context.subscriptions.push(
    configManager.setupWatcher(),
    configManager.onDidChange(async () => { await treeDataProvider.refresh(); }),
    treeView,
    { dispose: () => configManager.dispose() },
    { dispose: () => treeDataProvider.dispose() });

  configManager.ensureExists();

  // Restore last view if it still exists in config, otherwise show view list
  const lastView = context.workspaceState.get<string>("fileTag.lastView");
  if (!lastView) {
    treeDataProvider.loadViews();
    return;
  }

  configManager.read().then(config => {
    if (lastView in config.views) {
      treeDataProvider.selectView(lastView).then(() =>
        treeView.title = lastView);
      return;
    }

    context.workspaceState.update("fileTag.lastView", undefined);
    treeDataProvider.loadViews();
  });
}


export function deactivate(): void {}
