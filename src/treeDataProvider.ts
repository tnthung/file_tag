import * as vscode from "vscode";
import { resolveTag } from "./resolver";
import { ConfigManager } from "./config";
import { evaluateCondition } from "./evaluator";


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

export type TreeNode = FileNode | DirNode | ViewListNode | CategoryNode | TagNode | TagPatternNode;


// --- Tree building helpers ---

function insertUri(
  children: Map<string, TreeNode>,
  parts: string[],
  uri: vscode.Uri,
  depth: number,
): void {
  const name = parts[depth];
  const isFile = depth === parts.length - 1;

  if (isFile) {
    children.set(name, { kind: "file", name, uri });
    return;
  }

  let node = children.get(name);
  if (!node || node.kind !== "dir")
    children.set(name, node = {
      kind: "dir",
      name,
      relativePath: parts.slice(0, depth + 1).join("/"),
      children: [],
    });

  const dirNode = node as DirNode;
  const childMap = new Map<string, TreeNode>();
  for (const child of dirNode.children)
    childMap.set(nodeName(child), child);

  insertUri(childMap, parts, uri, depth + 1);
  dirNode.children = sortNodes(Array.from(childMap.values()));
}

function buildTreeFromParts(uris: vscode.Uri[], workspaceFolder: vscode.WorkspaceFolder): TreeNode[] {
  const rootMap = new Map<string, TreeNode>();
  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    insertUri(rootMap, rel.split("/"), uri, 0);
  }
  return sortNodes(Array.from(rootMap.values()));
}

function nodeName(n: TreeNode): string {
  if (n.kind === "category") return n.label;
  if (n.kind === "tagPattern") return n.pattern;
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
const CATEGORY_TAGS: CategoryNode  = { kind: "category", label: "Tags"  };

export class FileTagTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentViewName: string | undefined;
  private previewState: { name: string; patterns: string[] } | undefined;
  private showingFiles = false;
  private rootNodes: TreeNode[] = [];

  // Selection-mode data
  private viewNodes: ViewListNode[] = [];
  private tagNodes: TagNode[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
  ) {}

  getCurrentViewName(): string | undefined {
    return this.currentViewName;
  }

  async clearView(): Promise<void> {
    this.currentViewName = undefined;
    this.previewState = undefined;
    this.showingFiles = false;
    await this.loadViews();
  }

  async showTagPreview(name: string, patterns: string[]): Promise<void> {
    this.currentViewName = undefined;
    this.previewState = { name, patterns };
    this.showingFiles = true;
    vscode.commands.executeCommand("setContext", "fileTag.selectingView", false);
    const uris = await resolveTag(patterns, this.workspaceFolder);
    this.rootNodes = buildTreeFromParts(uris, this.workspaceFolder);
    this._onDidChangeTreeData.fire();
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

    vscode.commands.executeCommand("setContext", "fileTag.selectingView", true);
    this._onDidChangeTreeData.fire();
  }

  async selectView(viewName: string): Promise<void> {
    this.currentViewName = viewName;
    this.previewState = undefined;
    this.showingFiles = true;
    vscode.commands.executeCommand("setContext", "fileTag.selectingView", false);

    eval: {
      const config = await this.configManager.read();
      const condition = config.views[viewName];
      if (!condition) { this.rootNodes = []; break eval; }

      const uris = await evaluateCondition(condition, config, this.workspaceFolder);
      this.rootNodes = buildTreeFromParts(uris, this.workspaceFolder);
    }

    this._onDidChangeTreeData.fire();
  }

  async refresh(): Promise<void> {
    if (this.currentViewName) return this.selectView(this.currentViewName);
    if (this.previewState) return this.showTagPreview(this.previewState.name, this.previewState.patterns);
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
    if (node.kind === "category") return undefined;
    if (node.kind === "viewList") return CATEGORY_VIEWS;
    if (node.kind === "tag") return CATEGORY_TAGS;
    if (node.kind === "tagPattern") return node.parent;

    // File tree parents
    const search = (nodes: TreeNode[], parent?: TreeNode): TreeNode | undefined => {
      for (const child of nodes) {
        if (child === node) return parent;
        if (child.kind === "dir") {
          const found = search(child.children, child);
          if (found !== undefined) return found;
        }
      }
    };

    return search(this.rootNodes);
  }

  findFileNode(uri: vscode.Uri): FileNode | undefined {
    const target = uri.toString();
    const search = (nodes: TreeNode[]): FileNode | undefined => {
      for (const node of nodes) {
        if (node.kind === "file" && node.uri.toString() === target) return node;
        if (node.kind === "dir") {
          const found = search(node.children);
          if (found) return found;
        }
      }
    };

    return search(this.rootNodes);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
