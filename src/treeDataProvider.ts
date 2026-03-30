import * as vscode from "vscode";
import * as path from "path";
import { ConfigManager } from "./config";
import { evaluateCondition } from "./evaluator";


export class FileTagTreeDataProvider implements vscode.TreeDataProvider<vscode.Uri> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentViewName: string | undefined;
  private files: vscode.Uri[] = [];

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
      if (!condition) { this.files = []; break eval; }

      this.files = await evaluateCondition(condition, config, this.workspaceFolder);
      this.files.sort((a, b) => {
        const relA = vscode.workspace.asRelativePath(a, false);
        const relB = vscode.workspace.asRelativePath(b, false);
        return relA.localeCompare(relB);
      });
    }

    this._onDidChangeTreeData.fire();
  }

  async refresh(): Promise<void> {
    if (this.currentViewName)
      await this.selectView(this.currentViewName);
  }

  getTreeItem(uri: vscode.Uri): vscode.TreeItem {
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.label = path.basename(uri.fsPath);
    item.description = vscode.workspace.asRelativePath(uri, false);
    item.resourceUri = uri;
    item.contextValue = "fileTagFile";
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [uri],
    };
    return item;
  }

  getChildren(element?: vscode.Uri): vscode.Uri[] {
    if (element) return [];
    return this.files;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
