import * as vscode from "vscode";
import { FileTagConfig } from "./types";


const CONFIG_FILENAME = "file-tag.json";
const DEFAULT_CONFIG: FileTagConfig = { tags: {}, views: {} };


export class ConfigManager {
  private readonly configUri: vscode.Uri;
  private readonly _onDidChange = new vscode.EventEmitter<FileTagConfig>();
  readonly onDidChange = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.configUri = vscode.Uri.joinPath(
      workspaceFolder.uri, ".vscode", CONFIG_FILENAME);
  }

  getConfigUri(): vscode.Uri {
    return this.configUri;
  }

  async read(): Promise<FileTagConfig> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.configUri);
      const parsed = JSON.parse(Buffer.from(raw).toString("utf-8"));
      return {
        tags: parsed.tags ?? {},
        views: parsed.views ?? {},
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async write(config: FileTagConfig): Promise<void> {
    const vscodeDir = vscode.Uri.joinPath(
      this.workspaceFolder.uri, ".vscode");
    try {
      await vscode.workspace.fs.stat(vscodeDir);
    } catch {
      await vscode.workspace.fs.createDirectory(vscodeDir);
    }

    const content = JSON.stringify(config, null, 4) + "\n";
    await vscode.workspace.fs.writeFile(
      this.configUri, Buffer.from(content, "utf-8"));
    this._onDidChange.fire(config);
  }

  async ensureExists(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(this.configUri);
    } catch {
      await this.write({ ...DEFAULT_CONFIG });
    }
  }

  setupWatcher(): vscode.Disposable {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, `.vscode/${CONFIG_FILENAME}`),);

    const reload = async () => {
      const config = await this.read();
      this._onDidChange.fire(config);
    };

    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);

    return this.watcher;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
