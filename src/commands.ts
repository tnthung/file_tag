import * as vscode from "vscode";
import { logTiming } from "./timing";
import { FileTagEngine } from "./engine";
import { ViewCondition } from "./types";
import { ConfigManager } from "./config";
import {
  FileTagTreeDataProvider,
  TreeNode,
  DirNode,
  FileNode,
  TagNode,
  TagPatternNode,
  ViewListNode,
  CATEGORY_TAGS,
} from "./treeDataProvider";


const LAST_VIEW_KEY = "fileTag.lastView";
const WORKSPACE_FOLDER_PREFIX = "${workspaceFolder}/";

const CLIPBOARD_CONTEXT_KEY = "fileTag.clipboardHasFile";

// Internal clipboard for copy/paste file operations
let copyClipboard: vscode.Uri[] = [];
let systemClipboardHasFiles = false;
let clipboardContextValue = false;
let clipboardContextInitialized = false;
let clipboardScanInFlight = false;

function updateClipboardContext(): void {
  const next = copyClipboard.length > 0 || systemClipboardHasFiles;
  if (clipboardContextInitialized && next === clipboardContextValue) return;
  clipboardContextInitialized = true;
  clipboardContextValue = next;
  void vscode.commands.executeCommand("setContext", CLIPBOARD_CONTEXT_KEY, next);
}

function isFileSystemNode(node: TreeNode): node is FileNode | DirNode {
  return node.kind === "file" || node.kind === "dir";
}

function getSelectedFsNodes(node: TreeNode | undefined, treeView: vscode.TreeView<TreeNode>): (FileNode | DirNode)[] {
  if (node && isFileSystemNode(node)) return [node];
  const selection = treeView.selection.filter(isFileSystemNode);
  return selection.length > 0 ? selection : [];
}

function getSingleFsNode(node: TreeNode | undefined, treeView: vscode.TreeView<TreeNode>): FileNode | DirNode | undefined {
  const [first] = getSelectedFsNodes(node, treeView);
  return first;
}

function getDirectoryTarget(node: TreeNode | undefined, treeView: vscode.TreeView<TreeNode>, workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  const current = node && isFileSystemNode(node) ? node : treeView.selection.find(isFileSystemNode);
  if (!current) return workspaceFolder.uri;
  if (current.kind === "dir")
    return nodeUri(current, workspaceFolder);
  return vscode.Uri.joinPath(nodeUri(current, workspaceFolder), "..");
}

function describeNode(node: TreeNode | undefined): string {
  if (!node) return "none";
  switch (node.kind) {
    case "file":
      return `file:${node.uri.fsPath}`;
    case "dir":
      return `dir:${node.relativePath}`;
    case "viewList":
      return `view:${node.name}`;
    case "tag":
      return `tag:${node.name}`;
    default:
      return node.kind;
  }
}

function logCommandInvocation(command: string, node: TreeNode | undefined, treeView: vscode.TreeView<TreeNode>): void {
  const selection = treeView.selection.map(describeNode).join(", ");
  logTiming("commands", `${command} invoked | argument=${describeNode(node)} selection=[${selection}] totalSelection=${treeView.selection.length}`);
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound")
      return false;
    throw error;
  }
}

function validatePathSegment(segment: string): string | undefined {
  if (!segment.trim())
    return "Names cannot be empty";
  if (segment === "." || segment === "..")
    return "Names cannot be '.' or '..'";
  if (/[<>:"|?*]/.test(segment))
    return 'Names cannot include <>:"|?* characters';
  return undefined;
}

function parseNewEntryInput(value: string): { type: "file" | "folder"; segments: string[] } | { error: string } {
  const trimmed = value.trim();
  if (!trimmed)
    return { error: "Name cannot be empty" };

  const normalized = trimmed.replace(/\\/g, "/");
  const isFolder = normalized.endsWith("/");
  const target = isFolder ? normalized.slice(0, -1) : normalized;
  if (!target)
    return { error: "Provide at least one folder or file name" };

  const segments = target.split("/").filter(part => part.length > 0);
  if (segments.length === 0)
    return { error: "Provide at least one folder or file name" };

  for (const segment of segments) {
    const validation = validatePathSegment(segment);
    if (validation) return { error: validation };
  }

  return { type: isFolder ? "folder" : "file", segments };
}

function joinPathSegments(base: vscode.Uri, segments: string[]): vscode.Uri {
  let current = base;
  for (const segment of segments)
    current = vscode.Uri.joinPath(current, segment);
  return current;
}

function setClipboardItems(uris: vscode.Uri[]): void {
  copyClipboard = uris;
  updateClipboardContext();
}

async function parseSystemClipboardUris(maxEntries = Number.POSITIVE_INFINITY): Promise<vscode.Uri[]> {
  const text = (await vscode.env.clipboard.readText()).trim();
  if (!text) return [];

  const uris: vscode.Uri[] = [];
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    let parsed: vscode.Uri | undefined;

    try {
      parsed = line.startsWith("file://") ? vscode.Uri.parse(line) : vscode.Uri.file(line);

    } catch {
      continue;
    }

    try {
      await vscode.workspace.fs.stat(parsed);
      uris.push(parsed);
      if (uris.length >= maxEntries) break;

    } catch {
      // Ignore clipboard entries that do not exist on disk
    }
  }
  return uris;
}

async function refreshSystemClipboardState(): Promise<void> {
  if (clipboardScanInFlight) return;
  clipboardScanInFlight = true;

  try {
    const hasFiles = (await parseSystemClipboardUris(1)).length > 0;
    if (hasFiles !== systemClipboardHasFiles) {
      systemClipboardHasFiles = hasFiles;
      updateClipboardContext();
    }

  } finally {
    clipboardScanInFlight = false;
  }
}

async function findUniqueChildUri(dir: vscode.Uri, originalName: string): Promise<vscode.Uri> {
  const dot = originalName.lastIndexOf(".");
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot) : "";

  let attempt = originalName;
  let counter = 1;
  while (true) {
    const candidate = vscode.Uri.joinPath(dir, attempt);
    try {
      await vscode.workspace.fs.stat(candidate);
      counter++;
      attempt = `${base} copy${counter === 2 ? "" : ` ${counter - 1}`}${ext}`;

    } catch {
      return candidate;
    }
  }
}

function toTagList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value];
}

function rebuildLogical(children: ViewCondition[], key: "union" | "or" | "intersect" | "and"): ViewCondition {
  const filtered = children.filter(child => !(Array.isArray(child) && child.length === 0));
  if (filtered.length === 0) return [];
  if (filtered.length === 1) return filtered[0];
  return { [key]: filtered } as ViewCondition;
}

function conditionIsEmpty(cond: ViewCondition): boolean {
  if (typeof cond === "string") return false;
  if (Array.isArray(cond)) return cond.length === 0;
  if ("union" in cond) return (cond.union ?? []).length === 0;
  if ("or" in cond) return (cond.or ?? []).length === 0;
  if ("intersect" in cond) return (cond.intersect ?? []).length === 0;
  if ("and" in cond) return (cond.and ?? []).length === 0;
  if ("from" in cond) {
    const include = toTagList(cond.from);
    const exclude = toTagList(cond.exclude);
    return include.length === 0 && exclude.length === 0;
  }
  if ("subtract" in cond)
    return conditionIsEmpty(cond.subtract.include) && conditionIsEmpty(cond.subtract.exclude);
  return false;
}

function removeTagFromCondition(cond: ViewCondition, tagName: string): ViewCondition {
  if (typeof cond === "string") return cond === tagName ? [] : cond;
  if (Array.isArray(cond)) return cond.filter(t => t !== tagName);

  if ("union" in cond) {
    const children = cond.union.map(c => removeTagFromCondition(c, tagName));
    return rebuildLogical(children, "union");
  }

  if ("intersect" in cond) {
    const children = cond.intersect.map(c => removeTagFromCondition(c, tagName));
    return rebuildLogical(children, "intersect");
  }

  if ("subtract" in cond) {
    return {
      subtract: {
        include: removeTagFromCondition(cond.subtract.include, tagName),
        exclude: removeTagFromCondition(cond.subtract.exclude, tagName),
      },
    };
  }

  if ("from" in cond) {
    const include = toTagList(cond.from).filter(t => t !== tagName);
    const exclude = toTagList(cond.exclude).filter(t => t !== tagName);
    if (include.length === 0 && exclude.length === 0) return [];
    return exclude.length > 0 ? { from: include, exclude } : { from: include };
  }

  if ("or"  in cond) {
    const children = cond.or.map( c => removeTagFromCondition(c, tagName)).filter(c => !Array.isArray(c) || c.length > 0);
    return children.length === 0 ? [] : { or: children };
  }

  if ("and" in cond) {
    const children = cond.and.map(c => removeTagFromCondition(c, tagName)).filter(c => !Array.isArray(c) || c.length > 0);
    return children.length === 0 ? [] : { and: children };
  }

  if ("not" in cond) {
    const inner = removeTagFromCondition(cond.not, tagName);
    return Array.isArray(inner) && inner.length === 0 ? [] : { not: inner };
  }

  return cond;
}

function renameTagInCondition(cond: ViewCondition, oldName: string, newName: string): ViewCondition {
  if (typeof cond === "string") return cond === oldName ? newName : cond;
  if (Array.isArray(cond)) return cond.map(t => t === oldName ? newName : t);
  if ("union" in cond) return { union: cond.union.map(c => renameTagInCondition(c, oldName, newName)) };
  if ("intersect" in cond) return { intersect: cond.intersect.map(c => renameTagInCondition(c, oldName, newName)) };
  if ("subtract" in cond) return {
    subtract: {
      include: renameTagInCondition(cond.subtract.include, oldName, newName),
      exclude: renameTagInCondition(cond.subtract.exclude, oldName, newName),
    },
  };
  if ("from" in cond) {
    const include = toTagList(cond.from).map(tag => tag === oldName ? newName : tag);
    const exclude = toTagList(cond.exclude).map(tag => tag === oldName ? newName : tag);
    return exclude.length > 0 ? { from: include, exclude } : { from: include };
  }
  if ("or"  in cond) return { or:  cond.or.map( c => renameTagInCondition(c, oldName, newName)) };
  if ("and" in cond) return { and: cond.and.map(c => renameTagInCondition(c, oldName, newName)) };
  if ("not" in cond) return { not: renameTagInCondition(cond.not, oldName, newName) };
  return cond;
}

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
  engine: FileTagEngine,
): void {
  updateClipboardContext();
  void refreshSystemClipboardState();

  const clipboardFocusDisposable = vscode.window.onDidChangeWindowState(state => {
    if (state.focused)
      void refreshSystemClipboardState();
  });
  const clipboardPollHandle = setInterval(() => {
    if (vscode.window.state.focused)
      void refreshSystemClipboardState();
  }, 4000);

  context.subscriptions.push(
    clipboardFocusDisposable,
    new vscode.Disposable(() => clearInterval(clipboardPollHandle)),
  );

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

      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const defaultValue = activeUri
        ? WORKSPACE_FOLDER_PREFIX + vscode.workspace.asRelativePath(activeUri, false)
        : WORKSPACE_FOLDER_PREFIX;

      const pattern = await vscode.window.showInputBox({
        prompt: `Add first pattern to "${name.trim()}" (optional, press Escape or leave empty to skip)`,
        value: defaultValue,
        valueSelection: [defaultValue.length, defaultValue.length],
      });

      const tag = name.trim();
      config.tags[tag] = pattern?.trim() ? [pattern.trim()] : [];
      await configManager.write(config);
      treeView.reveal(CATEGORY_TAGS, { expand: true });
    }),

    vscode.commands.registerCommand("fileTag.addToTag", async (node: TagNode) => {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const defaultValue = activeUri
        ? WORKSPACE_FOLDER_PREFIX + vscode.workspace.asRelativePath(activeUri, false)
        : WORKSPACE_FOLDER_PREFIX;

      const pattern = await vscode.window.showInputBox({
        prompt: `Add pattern to "${node.name}"`,
        value: defaultValue,
        valueSelection: [defaultValue.length, defaultValue.length],
      });
      if (!pattern) return;

      const config = await configManager.read();
      config.tags[node.name].push(pattern);
      await configManager.write(config);
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

      const globs = await engine.getSearchGlobs(viewName);
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

    vscode.commands.registerCommand("fileTag.editView", async (node: ViewListNode) => {
      const config = await configManager.read();
      const condition = config.views[node.name];
      const tagNames = Object.keys(config.tags);

      // Resolve pre-selected tags for simple union conditions only
      let preSelected: string[] = [];
      let isSimple = false;
      if (typeof condition === "string") {
        preSelected = [condition];
        isSimple = true;
      } else if (Array.isArray(condition)) {
        preSelected = condition;
        isSimple = true;
      }

      if (!isSimple) {
        // Complex condition — fall back to opening config
        vscode.window.showInformationMessage(
          `"${node.name}" has a complex condition. Opening config for manual editing.`);
        await vscode.commands.executeCommand("fileTag.openConfig");
        return;
      }

      const selected = await vscode.window.showQuickPick(
        tagNames.map(name => ({ label: name, picked: preSelected.includes(name) })),
        { canPickMany: true, placeHolder: `Edit tags for "${node.name}"` },
      );
      if (!selected) return;

      config.views[node.name] = selected.length === 1
        ? selected[0].label
        : selected.map(s => s.label);
      await configManager.write(config);
    }),

    vscode.commands.registerCommand("fileTag.renameView", async (node: ViewListNode) => {
      const config = await configManager.read();
      const newName = await vscode.window.showInputBox({
        prompt: "Rename view",
        value: node.name,
        valueSelection: [0, node.name.length],
        validateInput: v => {
          if (!v.trim()) return "Name cannot be empty";
          if (v.trim() !== node.name && config.views[v.trim()]) return `View "${v.trim()}" already exists`;
          return undefined;
        },
      });
      if (!newName || newName.trim() === node.name) return;
      const name = newName.trim();
      config.views[name] = config.views[node.name];
      delete config.views[node.name];
      await configManager.write(config);

      // Update active view tracking if the renamed view was active
      if (treeDataProvider.getCurrentViewName() === node.name) {
        await treeDataProvider.selectView(name);
        treeView.title = name;
        context.workspaceState.update(LAST_VIEW_KEY, name);
      }
    }),

    vscode.commands.registerCommand("fileTag.renameTag", async (node: TagNode) => {
      const config = await configManager.read();
      const newName = await vscode.window.showInputBox({
        prompt: "Rename tag",
        value: node.name,
        valueSelection: [0, node.name.length],
        validateInput: v => {
          if (!v.trim()) return "Name cannot be empty";
          if (v.trim() !== node.name && config.tags[v.trim()]) return `Tag "${v.trim()}" already exists`;
          return undefined;
        },
      });
      if (!newName || newName.trim() === node.name) return;
      const name = newName.trim();

      // Rename in tags
      config.tags[name] = config.tags[node.name];
      delete config.tags[node.name];

      // Update all view conditions that reference the old tag name
      for (const [viewName, condition] of Object.entries(config.views))
        config.views[viewName] = renameTagInCondition(condition, node.name, name);

      await configManager.write(config);
    }),

    vscode.commands.registerCommand("fileTag.previewTag", async (node: TagNode) => {
      if (!node || node.kind !== "tag") return;
      await treeDataProvider.showTagPreview(node.name);
      treeView.title = `${node.name} (preview)`;
    }),

    vscode.commands.registerCommand("fileTag.deleteTag", async (node: TagNode) => {
      const answer = await vscode.window.showWarningMessage(
        `Delete tag "${node.name}"?`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") return;
      const config = await configManager.read();
      delete config.tags[node.name];
      for (const [viewName, condition] of Object.entries(config.views))
        config.views[viewName] = removeTagFromCondition(condition, node.name);
      await configManager.write(config);
    }),

    vscode.commands.registerCommand("fileTag.deletePattern", async (node: TagPatternNode) => {
      const config = await configManager.read();
      const patterns = config.tags[node.parent.name];
      if (!patterns) return;
      const idx = patterns.indexOf(node.pattern);
      if (idx === -1) return;
      patterns.splice(idx, 1);
      await configManager.write(config);
    }),

    vscode.commands.registerCommand("fileTag.refreshView", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "File Tag: Refreshing..." },
        () => treeDataProvider.refresh("command:refreshView"));
      vscode.window.setStatusBarMessage("$(check) File Tag refreshed", 2000);
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

    vscode.commands.registerCommand("fileTag.newFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.newFile", node, treeView);
      const destination = getDirectoryTarget(node, treeView, workspaceFolder);
      const name = await vscode.window.showInputBox({
        prompt: "Enter a file path (append / or \\ to create folders)",
        placeHolder: "folder/subfolder/file.ts or folder\\",
        validateInput: value => {
          const result = parseNewEntryInput(value);
          return "error" in result ? result.error : undefined;
        },
      });
      if (!name) return;

      const parsed = parseNewEntryInput(name);
      if ("error" in parsed) {
        vscode.window.showErrorMessage(parsed.error);
        return;
      }

      if (parsed.type === "folder") {
        const folderUri = joinPathSegments(destination, parsed.segments);
        try {
          if (await pathExists(folderUri)) {
            vscode.window.showErrorMessage(`"${name.trim()}" already exists.`);
            return;
          }
          await vscode.workspace.fs.createDirectory(folderUri);
          await engine.notifyFileCreated("command:newFile:folder", [folderUri]);

        } catch (error) {
          vscode.window.showErrorMessage(`Create folder failed: ${error instanceof Error ? error.message : error}`);
        }
        return;
      }

      const dirSegments = parsed.segments.slice(0, -1);
      const fileName = parsed.segments[parsed.segments.length - 1];
      const parentDir = joinPathSegments(destination, dirSegments);
      const fileUri = vscode.Uri.joinPath(parentDir, fileName);

      try {
        if (await pathExists(fileUri)) {
          vscode.window.showErrorMessage(`"${name.trim()}" already exists.`);
          return;
        }

        await vscode.workspace.fs.createDirectory(parentDir);
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
        await engine.notifyFileCreated("command:newFile:file", [fileUri]);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);

      } catch (error) {
        vscode.window.showErrorMessage(`Create file failed: ${error instanceof Error ? error.message : error}`);
      }
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

    vscode.commands.registerCommand("fileTag.copyFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.copyFile", node, treeView);
      const targets = getSelectedFsNodes(node, treeView);
      if (targets.length === 0) {
        vscode.window.showInformationMessage("Select at least one file or directory to copy.");
        return;
      }
      const uris = targets.map(target => nodeUri(target, workspaceFolder));
      setClipboardItems(uris);
      vscode.window.setStatusBarMessage(`File Tag: copied ${uris.length} item${uris.length === 1 ? "" : "s"}`, 2000);
    }),

    vscode.commands.registerCommand("fileTag.pasteFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.pasteFile", node, treeView);
      let sources = copyClipboard;
      if (sources.length === 0) {
        sources = await parseSystemClipboardUris();
        systemClipboardHasFiles = sources.length > 0;
        updateClipboardContext();
        vscode.window.showInformationMessage("Clipboard does not contain copied files.");
        return;
      }

      const destination = getDirectoryTarget(node, treeView, workspaceFolder);
      const created: vscode.Uri[] = [];
      for (const source of sources) {
        const name = source.path.split("/").pop();
        if (!name) continue;
        let stat: vscode.FileStat;

        try {
          stat = await vscode.workspace.fs.stat(source);

        } catch (error) {
          vscode.window.showErrorMessage(`Paste skipped: source "${source.fsPath}" is not accessible.`);
          continue;
        }

        try {
          const targetUri = await findUniqueChildUri(destination, name);
          await vscode.workspace.fs.copy(source, targetUri, { overwrite: false });
          if ((stat.type & vscode.FileType.Directory) === 0)
            created.push(targetUri);

        } catch (error) {
          vscode.window.showErrorMessage(`Paste failed for "${name}": ${error instanceof Error ? error.message : error}`);
        }
      }

      if (created.length > 0)
        await engine.notifyFileCreated("command:pasteFile", created);
    }),

    vscode.commands.registerCommand("fileTag.duplicateFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.duplicateFile", node, treeView);
      const target = getSingleFsNode(node, treeView);
      if (!target) {
        vscode.window.showInformationMessage("Select a file or directory to duplicate.");
        return;
      }

      const uri = nodeUri(target, workspaceFolder);
      const newUri = await findFreeCopyUri(uri);
      try {
        await vscode.workspace.fs.copy(uri, newUri, { overwrite: false });
        await engine.notifyFileCreated("command:duplicateFile", [newUri]);

      } catch (e) {
        vscode.window.showErrorMessage(`Duplicate failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand("fileTag.renameFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.renameFile", node, treeView);
      const target = getSingleFsNode(node, treeView);
      if (!target) {
        vscode.window.showInformationMessage("Select a file or directory to rename.");
        return;
      }

      const uri = nodeUri(target, workspaceFolder);
      const dot = target.name.lastIndexOf(".");
      const selEnd = target.kind === "file" && dot > 0 ? dot : target.name.length;
      const newName = await vscode.window.showInputBox({
        prompt: "New name",
        value: target.name,
        valueSelection: [0, selEnd],
        validateInput: v => v.includes("/") || v.includes("\\") ? "Name cannot contain path separators" : undefined,
      });

      if (!newName || newName === target.name) return;
      const newUri = vscode.Uri.joinPath(uri, "..", newName);
      try {
        await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
        await engine.notifyFileRenamed("command:renameFile", [{ oldUri: uri, newUri }]);

      } catch (e) {
        vscode.window.showErrorMessage(`Rename failed: ${e}`);
      }
    }),

    vscode.commands.registerCommand("fileTag.deleteFile", async (node?: TreeNode) => {
      logCommandInvocation("fileTag.deleteFile", node, treeView);
      const targets = getSelectedFsNodes(node, treeView);
      if (targets.length === 0) {
        vscode.window.showInformationMessage("Select files or directories to delete.");
        return;
      }

      const preview = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`;
      const answer = await vscode.window.showWarningMessage(
        `Delete ${preview}?`, { modal: true }, "Move to Trash");
      if (answer !== "Move to Trash") return;

      for (const target of targets) {
        const uri = nodeUri(target, workspaceFolder);
        logTiming("treeUpdate", `delete command invoked | target=${uri.toString()} kind=${target.kind} view=${treeDataProvider.getCurrentViewName() ?? "none"}`);
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
          await engine.notifyFileDeleted("command:deleteFile", [uri]);

        } catch (e) {
          vscode.window.showErrorMessage(`Delete failed for "${target.name}": ${e}`);
        }
      }
    }),
  );
}
