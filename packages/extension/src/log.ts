import * as vscode from 'vscode'

export class Log {
  private ch: vscode.OutputChannel

  constructor(name: string) {
    this.ch = vscode.window.createOutputChannel(name)
  }

  private line(level: string, msg: string): void {
    const ts = new Date().toISOString().slice(11, 23)
    this.ch.appendLine(`${ts} ${level} ${msg}`)
  }

  info(msg: string): void {
    this.line('INFO ', msg)
  }
  warn(msg: string): void {
    this.line('WARN ', msg)
  }
  error(msg: string): void {
    this.line('ERROR', msg)
  }
  debug(msg: string): void {
    this.line('DEBUG', msg)
  }
  show(): void {
    this.ch.show(true)
  }
  dispose(): void {
    this.ch.dispose()
  }
}
