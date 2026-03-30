import * as vscode from "vscode";
import * as path from "path";
import { ConfigManager } from "./config";
import { evaluateCondition } from "./evaluator";


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

export type TreeNode = FileNode | DirNode | ViewListNode;


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
    childMap.set(child.name, child);

  insertUri(childMap, parts, uri, depth + 1);
  dirNode.children = sortNodes(Array.from(childMap.values()));
}


function buildTreeFromParts(
  uris: vscode.Uri[],
  workspaceFolder: vscode.WorkspaceFolder,
): TreeNode[] {
  const rootMap = new Map<string, TreeNode>();

  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const parts = rel.split("/");
    insertUri(rootMap, parts, uri, 0);
  }

  return sortNodes(Array.from(rootMap.values()));
}


function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind)
      return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}


export class FileTagTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentViewName: string | undefined;
  private rootNodes: TreeNode[] = [];
  private availableViews: string[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
  ) {}

  getCurrentViewName(): string | undefined {
    return this.currentViewName;
  }

  async clearView(): Promise<void> {
    this.currentViewName = undefined;
    await this.loadViews();
  }

  async loadViews(): Promise<void> {
    const config = await this.configManager.read();
    this.availableViews = Object.keys(config.views);
    vscode.commands.executeCommand("setContext", "fileTag.selectingView", true);
    this._onDidChangeTreeData.fire();
  }

  async selectView(viewName: string): Promise<void> {
    this.currentViewName = viewName;
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
    if (!this.currentViewName)
      return await this.loadViews();
    await this.selectView(this.currentViewName);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "viewList") {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("eye");
      item.contextValue = "fileTagViewListItem";
      item.command = {
        command: "fileTag.openView",
        title: "Open View",
        arguments: [node.name],
      };
      return item;
    }

    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
      item.label = node.name;
      item.resourceUri = node.uri;
      item.contextValue = "fileTagFile";
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [node.uri],
      };
      return item;
    }

    // Directory node
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = vscode.Uri.joinPath(this.workspaceFolder.uri, node.relativePath);
    item.contextValue = "fileTagDir";
    item.iconPath = vscode.ThemeIcon.Folder;
    return item;
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

  getParent(node: TreeNode): TreeNode | undefined {
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

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      if (this.currentViewName) return this.rootNodes;
      return this.availableViews.map(name => ({ kind: "viewList", name }));
    }

    if (node.kind === "dir") return node.children;
    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
