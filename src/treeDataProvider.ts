import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { FileTagEngine } from "./engine";
import { TimingLog } from "./timing";


// --- Node types ---

export interface FileNode {
  kind: "file";
  name: string;
  uri: vscode.Uri;
}

export interface DirNode {
  kind: "dir";
  name: string;
  relativePath: string;
  children: TreeNode[];
}

export interface ViewListNode {
  kind: "viewList";
  name: string;
}

export interface CategoryNode {
  kind: "category";
  label: "Views" | "Tags";
}

export interface TagNode {
  kind: "tag";
  name: string;
  patterns: string[];
}

export interface TagPatternNode {
  kind: "tagPattern";
  pattern: string;
  parent: TagNode;
}

export interface LoadingNode {
  kind: "loading";
}

export type TreeNode = FileNode | DirNode | ViewListNode | CategoryNode | TagNode | TagPatternNode | LoadingNode;


// --- Tree building helpers ---

interface MutableDirNode extends DirNode {
  childMap?: Map<string, TreeNode>;
}

function createDirNode(name: string, relativePath: string): MutableDirNode {
  return {
    kind: "dir",
    name,
    relativePath,
    children: [],
    childMap: new Map<string, TreeNode>(),
  };
}

function finalizeNodes(children: Map<string, TreeNode>): TreeNode[] {
  const nodes = Array.from(children.values());
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    const dirNode = node as MutableDirNode;
    dirNode.children = finalizeNodes(dirNode.childMap ?? new Map<string, TreeNode>());
    delete dirNode.childMap;
  }
  return sortNodes(nodes);
}

function buildTreeFromParts(uris: vscode.Uri[], workspaceFolder: vscode.WorkspaceFolder): TreeNode[] {
  const rootMap = new Map<string, TreeNode>();

  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const parts = rel.split("/");
    let children = rootMap;

    for (let depth = 0; depth < parts.length; depth++) {
      const name = parts[depth];
      const isFile = depth === parts.length - 1;

      if (isFile) {
        children.set(name, { kind: "file", name, uri });
        break;
      }

      let node = children.get(name);
      if (!node || node.kind !== "dir") {
        node = createDirNode(name, parts.slice(0, depth + 1).join("/"));
        children.set(name, node);
      }

      children = (node as MutableDirNode).childMap ?? new Map<string, TreeNode>();
      (node as MutableDirNode).childMap = children;
    }
  }

  return finalizeNodes(rootMap);
}

function nodeName(n: TreeNode): string {
  if (n.kind === "category") return n.label;
  if (n.kind === "tagPattern") return n.pattern;
  if (n.kind === "loading") return "";
  return n.name;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return nodeName(a).localeCompare(nodeName(b));
  });
}


// --- Provider ---

const CATEGORY_VIEWS: CategoryNode = { kind: "category", label: "Views" };
export const CATEGORY_TAGS: CategoryNode  = { kind: "category", label: "Tags"  };
const LOADING_NODE: LoadingNode = { kind: "loading" };

export class FileTagTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentViewName: string | undefined;
  private previewState: { name: string } | undefined;
  private showingFiles = false;
  private loading = false;
  private rootNodes: TreeNode[] = [];
  private fileNodeByUri = new Map<string, FileNode>();
  private parentByNode = new WeakMap<TreeNode, TreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  // Selection-mode data
  private viewNodes: ViewListNode[] = [];
  private tagNodes: TagNode[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly engine: FileTagEngine,
  ) {
    this.disposables.push(
      this.engine.onDidInvalidate(() => { void this.refresh(); }),
    );
  }

  private clearFileTree(): void {
    this.rootNodes = [];
    this.fileNodeByUri.clear();
    this.parentByNode = new WeakMap<TreeNode, TreeNode | undefined>();
  }

  private setRootNodes(nodes: TreeNode[]): void {
    this.clearFileTree();
    this.rootNodes = nodes;

    const visit = (items: TreeNode[], parent: TreeNode | undefined): void => {
      for (const item of items) {
        this.parentByNode.set(item, parent);
        if (item.kind === "file") {
          this.fileNodeByUri.set(item.uri.toString(), item);
          continue;
        }

        if (item.kind === "dir")
          visit(item.children, item);
      }
    };

    visit(nodes, undefined);
  }

  getCurrentViewName(): string | undefined {
    return this.currentViewName;
  }

  async clearView(): Promise<void> {
    this.currentViewName = undefined;
    this.previewState = undefined;
    this.showingFiles = false;
    this.clearFileTree();
    await this.loadViews();
  }

  async showTagPreview(name: string): Promise<void> {
    const timing = new TimingLog(`showTagPreview(${name})`);
    this.currentViewName = undefined;
    this.previewState = { name };
    this.showingFiles = true;
    this.loading = true;
    this.clearFileTree();

    vscode.commands.executeCommand("setContext", "fileTag.selectingView", false);
    this._onDidChangeTreeData.fire();

    try {
      const uris = await this.engine.evaluateTags([name], `preview:${name}`);
      timing.step("resolve tag patterns", `${uris.length} files`);

      const rootNodes = buildTreeFromParts(uris, this.workspaceFolder);
      timing.step("build tree", `${rootNodes.length} root nodes`);

      this.setRootNodes(rootNodes);
      timing.step("index tree", `${uris.length} files`);
      timing.end();
    } catch (error) {
      timing.fail(error);
      throw error;
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  async loadViews(): Promise<void> {
    const config = await this.configManager.read();

    this.viewNodes = Object.keys(config.views).map(name => ({
      kind: "viewList",
      name,
    }));

    this.tagNodes = Object.entries(config.tags).map(([name, patterns]) => ({
      kind: "tag",
      name,
      patterns,
    }));

    this.clearFileTree();
    vscode.commands.executeCommand("setContext", "fileTag.selectingView", true);
    this._onDidChangeTreeData.fire();
  }

  async selectView(viewName: string): Promise<void> {
    const timing = new TimingLog(`selectView(${viewName})`);
    this.currentViewName = viewName;
    this.previewState = undefined;
    this.showingFiles = true;
    this.loading = true;

    this.clearFileTree();
    vscode.commands.executeCommand("setContext", "fileTag.selectingView", false);
    this._onDidChangeTreeData.fire();

    try {
      const config = await this.configManager.read();
      timing.step("read config", `${Object.keys(config.tags).length} tags, ${Object.keys(config.views).length} views`);

      const uris = await this.engine.evaluateView(viewName);
      timing.step("evaluate condition", `${uris.length} files`);

      const rootNodes = buildTreeFromParts(uris, this.workspaceFolder);
      timing.step("build tree", `${rootNodes.length} root nodes`);

      this.setRootNodes(rootNodes);
      timing.step("index tree", `${uris.length} files`);
      timing.end();
    } catch (error) {
      timing.fail(error);
      throw error;
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  async refresh(): Promise<void> {
    if (this.currentViewName) return this.selectView(this.currentViewName);
    if (this.previewState) return this.showTagPreview(this.previewState.name);
    return this.loadViews();
  }

  // --- TreeDataProvider ---

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "category": {
        const state = node.label === "Tags"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;
        const item = new vscode.TreeItem(node.label, state);
        item.contextValue = node.label === "Views" ? "fileTagCategoryViews" : "fileTagCategoryTags";
        return item;
      }
      case "viewList": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("eye");
        item.contextValue = "fileTagViewListItem";
        item.command = { command: "fileTag.openView", title: "Open View", arguments: [node.name] };
        return item;
      }
      case "tag": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("tag");
        item.description = `${node.patterns.length} pattern${node.patterns.length !== 1 ? "s" : ""}`;
        item.contextValue = "fileTagTag";
        return item;
      }
      case "tagPattern": {
        const item = new vscode.TreeItem(node.pattern, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("symbol-file");
        item.contextValue = "fileTagPattern";
        return item;
      }
      case "loading": {
        const item = new vscode.TreeItem("Loading...", vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("loading~spin");
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
        item.label = node.name;
        item.resourceUri = node.uri;
        item.contextValue = "fileTagFile";
        item.command = { command: "vscode.open", title: "Open", arguments: [node.uri] };
        return item;
      }
      case "dir": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.resourceUri = vscode.Uri.joinPath(this.workspaceFolder.uri, node.relativePath);
        item.contextValue = "fileTagDir";
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      if (this.loading) return [LOADING_NODE];
      if (this.showingFiles) return this.rootNodes;
      return [CATEGORY_TAGS, CATEGORY_VIEWS];
    }

    switch (node.kind) {
      case "category":
        return node.label === "Views" ? this.viewNodes : this.tagNodes;
      case "tag":
        return node.patterns.map(pattern => ({ kind: "tagPattern", pattern, parent: node }));
      case "dir":
        return node.children;
      default:
        return [];
    }
  }

  getParent(node: TreeNode): TreeNode | undefined {
    // Selection mode parents
    if (node.kind === "loading")  return undefined;
    if (node.kind === "category") return undefined;
    if (node.kind === "viewList") return CATEGORY_VIEWS;
    if (node.kind === "tag") return CATEGORY_TAGS;
    if (node.kind === "tagPattern") return node.parent;

    return this.parentByNode.get(node);
  }

  findFileNode(uri: vscode.Uri): FileNode | undefined {
    return this.fileNodeByUri.get(uri.toString());
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidChangeTreeData.dispose();
  }
}
