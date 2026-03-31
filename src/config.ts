import * as vscode from "vscode";
import { FileTagConfig } from "./types";


const CONFIG_FILENAME = "file-tag.json";
const DEFAULT_CONFIG: FileTagConfig = { tags: {}, views: {} };


export class ConfigManager {
  private readonly configUri: vscode.Uri;
  private readonly _onDidChange = new vscode.EventEmitter<FileTagConfig>();
  readonly onDidChange = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private cachedConfig: FileTagConfig | undefined;

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.configUri = vscode.Uri.joinPath(
      workspaceFolder.uri, ".vscode", CONFIG_FILENAME);
  }

  getConfigUri(): vscode.Uri {
    return this.configUri;
  }

  private normalizeConfig(parsed: unknown): FileTagConfig {
    const config = (parsed ?? {}) as Partial<FileTagConfig>;
    return {
      tags: config.tags ?? {},
      views: config.views ?? {},
    };
  }

  private invalidateCache(): void {
    this.cachedConfig = undefined;
  }

  async read(): Promise<FileTagConfig> {
    if (this.cachedConfig)
      return this.cachedConfig;

    try {
      const raw = await vscode.workspace.fs.readFile(this.configUri);
      this.cachedConfig = this.normalizeConfig(JSON.parse(Buffer.from(raw).toString("utf-8")));

    } catch {
      this.cachedConfig = { ...DEFAULT_CONFIG };
    }

    return this.cachedConfig;
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
    this.cachedConfig = config;
    this._onDidChange.fire(this.cachedConfig);
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
      this.invalidateCache();
      const config = await this.read();
      this._onDidChange.fire(config);
    };

    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);

    return this.watcher;
  }

  dispose(): void {
    this.invalidateCache();
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
