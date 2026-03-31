import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { registerCommands } from "./commands";
import { FileTagEngine } from "./engine";
import {
  TreeNode,
  FileNode,
  FileTagTreeDataProvider,
} from "./treeDataProvider";
import {
  getTimingOutputChannel,
  showTimingOutputChannel,
  logTiming,
} from "./timing";


function describeTreeNode(node: TreeNode | undefined): string {
  if (!node) return "none";

  switch (node.kind) {
    case "file":
      return `file:${node.uri.toString()}`;
    case "dir":
      return `dir:${node.relativePath}`;
    case "viewList":
      return `view:${node.name}`;
    case "tag":
      return `tag:${node.name}`;
    case "tagPattern":
      return `pattern:${node.pattern}`;
    case "category":
      return `category:${node.label}`;
    case "loading":
      return "loading";
    default:
      return (node as any).kind;
  }
}


function describeSelection(nodes: readonly TreeNode[] | undefined): string {
  if (!nodes || nodes.length === 0) return "[]";
  return `[${nodes.map(node => describeTreeNode(node)).join(", ")}]`;
}


function describeEditor(editor: vscode.TextEditor | undefined): string {
  if (!editor) return "none";
  const column = editor.viewColumn ?? "none";
  return `${editor.document.uri.toString()}@${column}`;
}


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

  let isTreeViewVisible = treeView.visible;
  const getFollowSetting = (): boolean =>
    vscode.workspace.getConfiguration("fileTag").get("followActiveEditor", true);

  let followActiveEditor = getFollowSetting();
  let activeEditorListener: vscode.Disposable | undefined;
  let pendingAutoRevealTarget: string | undefined;
  let pendingAutoRevealReason: string | undefined;
  let pendingAutoRevealExpiresAt = 0;
  let queuedAutoReveal: { uri: vscode.Uri; reason: string } | undefined;

  const clearPendingAutoReveal = (target?: string): void => {
    if (!target || pendingAutoRevealTarget === target) {
      pendingAutoRevealTarget = undefined;
      pendingAutoRevealReason = undefined;
      pendingAutoRevealExpiresAt = 0;
    }
  };

  const revealFileNode = (node: FileNode, reason: string): void => {
    if (!treeView.visible) {
      queuedAutoReveal = { uri: node.uri, reason };
      logTiming("autoReveal", `queued reveal target=${node.uri.toString()} reason=${reason} because view hidden`);
      return;
    }

    queuedAutoReveal = undefined;
    const target = node.uri.toString();
    pendingAutoRevealTarget = target;
    pendingAutoRevealReason = reason;
    pendingAutoRevealExpiresAt = Date.now() + 5000;

    logTiming("autoReveal", `attempting reveal target=${target} reason=${reason} focus=false selectionBefore=${describeSelection(treeView.selection)}`);
    treeView.reveal(node, { select: true, focus: false }).then(() => {
      logTiming("autoReveal", `reveal resolved target=${target} reason=${reason} selectionAfter=${describeSelection(treeView.selection)} treeVisible=${treeView.visible} activeEditorAfter=${describeEditor(vscode.window.activeTextEditor ?? undefined)}`);
      clearPendingAutoReveal(target);
    }, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logTiming("autoReveal", `reveal failed target=${target} reason=${reason} | ${message}`);
      clearPendingAutoReveal(target);
    });
  };

  const flushQueuedAutoReveal = (): void => {
    if (!queuedAutoReveal) return;
    if (!followActiveEditor) {
      queuedAutoReveal = undefined;
      return;
    }

    const { uri, reason } = queuedAutoReveal;
    queuedAutoReveal = undefined;

    const node = treeDataProvider.findFileNode(uri);
    if (node) {
      revealFileNode(node, `${reason}:flush`);
      return;
    }
    logTiming("autoReveal", `queued reveal target missing from tree | target=${uri.toString()}`);
  };

  const handleActiveEditorChange = (editor: vscode.TextEditor | undefined): void => {
    logTiming("autoReveal", `onDidChangeActiveTextEditor invoked | follow=${followActiveEditor} visible=${isTreeViewVisible} editor=${describeEditor(editor)}`);
    if (!followActiveEditor) return;
    if (!editor) return;
    const node = treeDataProvider.findFileNode(editor.document.uri);
    if (node) {
      revealFileNode(node, "followActiveEditor");
    } else {
      queuedAutoReveal = undefined;
      logTiming("autoReveal", `no matching node for ${editor.document.uri.toString()}`);
    }
  };

  const registerActiveEditorListener = (): void => {
    activeEditorListener?.dispose();
    if (!followActiveEditor) return;
    activeEditorListener = vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChange);
  };

  registerActiveEditorListener();
  if (followActiveEditor && isTreeViewVisible)
    handleActiveEditorChange(vscode.window.activeTextEditor ?? undefined);

  context.subscriptions.push(
    vscode.commands.registerCommand("fileTag.showTimingLog", () => {
      showTimingOutputChannel();
    }),
    configManager.setupWatcher(),
    getTimingOutputChannel(),
    treeView.onDidChangeVisibility(event => {
      isTreeViewVisible = event.visible;
      logTiming("autoReveal", `tree visibility changed -> ${isTreeViewVisible}`);
      if (event.visible) {
        if (followActiveEditor)
          handleActiveEditorChange(vscode.window.activeTextEditor ?? undefined);
        flushQueuedAutoReveal();
      }
    }),
    treeView.onDidChangeSelection(event => {
      if (pendingAutoRevealTarget && Date.now() > pendingAutoRevealExpiresAt)
        clearPendingAutoReveal();
      const autoTriggered = pendingAutoRevealTarget
        ? event.selection.some(node => node.kind === "file" && node.uri.toString() === pendingAutoRevealTarget)
        : false;
      const cause = autoTriggered ? `auto:${pendingAutoRevealReason ?? "unknown"}` : "user";
      logTiming("autoReveal", `tree selection changed | cause=${cause} selection=${describeSelection(event.selection)} treeVisible=${treeView.visible}`);
      if (autoTriggered)
        clearPendingAutoReveal();
    }),
    treeView.onDidExpandElement(event => {
      if (event.element.kind === "dir")
        treeDataProvider.updateDirectoryExpansion(event.element, true);
    }),
    treeView.onDidCollapseElement(event => {
      if (event.element.kind === "dir")
        treeDataProvider.updateDirectoryExpansion(event.element, false);
    }),
    treeView,
    { dispose: () => configManager.dispose() },
    { dispose: () => treeDataProvider.dispose() },
    engine,
    new vscode.Disposable(() => activeEditorListener?.dispose()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("fileTag.followActiveEditor")) return;

      followActiveEditor = getFollowSetting();
      logTiming("autoReveal", `configuration changed followActiveEditor=${followActiveEditor}`);

      registerActiveEditorListener();
      if (followActiveEditor && isTreeViewVisible)
        handleActiveEditorChange(vscode.window.activeTextEditor ?? undefined);
    }),
    vscode.workspace.onDidCreateFiles(async (e) => {
      logTiming("treeUpdate", `workspace create ${e.files.map(f => f.path).join(", ")}`);
      await engine.notifyFileCreated("workspace:create", e.files);
    }),
    vscode.workspace.onDidDeleteFiles(async (e) => {
      logTiming("treeUpdate", `workspace delete ${e.files.map(f => f.path).join(", ")}`);
      await engine.notifyFileDeleted("workspace:delete", e.files);
    }),
    vscode.workspace.onDidRenameFiles(async (e) => {
      logTiming("treeUpdate", `workspace rename ${e.files.map(f => `${f.oldUri.path}->${f.newUri.path}`).join(", ")}`);
      await engine.notifyFileRenamed("workspace:rename", e.files);
    }),
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
