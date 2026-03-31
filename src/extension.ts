import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { registerCommands } from "./commands";
import {
  TreeNode,
  FileTagTreeDataProvider,
} from "./treeDataProvider";
import { FileTagEngine } from "./engine";
import {
  getTimingOutputChannel,
  showTimingOutputChannel,
} from "./timing";


export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;

  const workspaceFolder = workspaceFolders[0];
  const configManager = new ConfigManager(workspaceFolder);
  const engine = new FileTagEngine(workspaceFolder, configManager);
  await engine.init();
  const treeDataProvider = new FileTagTreeDataProvider(configManager, workspaceFolder, engine);

  const treeView = vscode.window.createTreeView<TreeNode>("fileTagView", {
    treeDataProvider,
  });

  registerCommands(context, configManager, treeDataProvider, treeView, workspaceFolder, engine);

  context.subscriptions.push(
    vscode.commands.registerCommand("fileTag.showTimingLog", () => {
      showTimingOutputChannel();
    }),
    configManager.setupWatcher(),
    getTimingOutputChannel(),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const node = treeDataProvider.findFileNode(editor.document.uri);
      if (node) treeView.reveal(node, { select: true, focus: false });
    }),
    treeView,
    { dispose: () => configManager.dispose() },
    { dispose: () => treeDataProvider.dispose() },
    engine,
  );

  // Restore last view if it still exists in config, otherwise show view list
  const lastView = context.workspaceState.get<string>("fileTag.lastView");
  if (!lastView) {
    await treeDataProvider.loadViews();
    return;
  }

  const config = await configManager.read();
  if (lastView in config.views) {
    await treeDataProvider.selectView(lastView);
    treeView.title = lastView;
    return;
  }

  await context.workspaceState.update("fileTag.lastView", undefined);
  await treeDataProvider.loadViews();
}


export function deactivate(): void {}
