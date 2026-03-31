import * as vscode from "vscode";
import { performance } from "perf_hooks";


let outputChannel: vscode.OutputChannel | undefined;


function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel)
    outputChannel = vscode.window.createOutputChannel("File Tag Timing");

  return outputChannel;
}


function formatMs(durationMs: number): string {
  return `${durationMs.toFixed(durationMs >= 100 ? 0 : 1)} ms`;
}


function timestamp(): string {
  return new Date().toISOString();
}


export function getTimingOutputChannel(): vscode.OutputChannel {
  return getOutputChannel();
}


export function showTimingOutputChannel(preserveFocus = false): void {
  getOutputChannel().show(preserveFocus);
}


export function logTiming(scope: string, message: string): void {
  getOutputChannel().appendLine(`[${timestamp()}] ${scope} | ${message}`);
}


export class TimingLog {
  private readonly startedAt = performance.now();
  private lastStepAt = this.startedAt;

  constructor(private readonly scope: string) {
    logTiming(this.scope, "start");
  }

  step(name: string, details?: string): void {
    const now = performance.now();
    const delta = now - this.lastStepAt;
    const total = now - this.startedAt;
    const suffix = details ? ` | ${details}` : "";
    logTiming(this.scope, `${name}: +${formatMs(delta)} (${formatMs(total)} total)${suffix}`);
    this.lastStepAt = now;
  }

  end(details?: string): void {
    const total = performance.now() - this.startedAt;
    const suffix = details ? ` | ${details}` : "";
    logTiming(this.scope, `done: ${formatMs(total)}${suffix}`);
  }

  fail(error: unknown): void {
    const total = performance.now() - this.startedAt;
    const message = error instanceof Error ? error.message : String(error);
    logTiming(this.scope, `failed after ${formatMs(total)} | ${message}`);
  }
}