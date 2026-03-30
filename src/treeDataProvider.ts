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

export type TreeNode = FileNode | DirNode;


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
    // Directories before files
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

  constructor(
    private readonly configManager: ConfigManager,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
  ) {}

  getCurrentViewName(): string | undefined {
    return this.currentViewName;
  }

  async selectView(viewName: string): Promise<void> {
    this.currentViewName = viewName;

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
    if (this.currentViewName)
      await this.selectView(this.currentViewName);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
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

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.rootNodes;
    if (node.kind === "dir") return node.children;
    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
