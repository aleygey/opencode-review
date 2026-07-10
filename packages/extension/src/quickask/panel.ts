import * as vscode from 'vscode'

// Minimal streaming answer panel. Content is escaped and rendered in a pre-wrap body —
// good enough for code-heavy answers without pulling in a markdown renderer.
export class AskPanel {
  private static current: AskPanel | undefined
  private panel: vscode.WebviewPanel
  private buffer = ''
  onStop: (() => void) | undefined

  static show(): AskPanel {
    if (AskPanel.current) {
      AskPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
      return AskPanel.current
    }
    return new AskPanel()
  }

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'ocReview.ask',
      'OC Review — Ask',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // retainContextWhenHidden: streamed answers must survive the panel being tabbed away
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.webview.html = this.html()
    this.panel.onDidDispose(() => {
      if (AskPanel.current === this) AskPanel.current = undefined
      this.onStop?.()
    })
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'stop') this.onStop?.()
    })
    AskPanel.current = this
  }

  startQuestion(q: string): void {
    this.buffer = ''
    void this.panel.webview.postMessage({ type: 'question', text: q })
  }

  appendAnswer(text: string): void {
    this.buffer += text
    void this.panel.webview.postMessage({ type: 'append', text })
  }

  setAnswer(text: string): void {
    this.buffer = text
    void this.panel.webview.postMessage({ type: 'set', text })
  }

  status(text: string): void {
    void this.panel.webview.postMessage({ type: 'status', text })
  }

  get answerLength(): number {
    return this.buffer.length
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 14px 40px; }
  h3 { margin: 12px 0 4px; }
  #q { color: var(--vscode-descriptionForeground); white-space: pre-wrap; border-left: 3px solid var(--vscode-focusBorder); padding-left: 8px; }
  #a { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
  #status { position: fixed; bottom: 0; left: 0; right: 0; padding: 4px 14px; font-size: 11px;
            color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background);
            display: flex; justify-content: space-between; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 2px 10px; cursor: pointer; }
</style></head>
<body>
  <h3>Question</h3><div id="q"></div>
  <h3>Answer</h3><div id="a"></div>
  <div id="status"><span id="st">idle</span><button id="stop">Stop</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q'), a = document.getElementById('a'), st = document.getElementById('st');
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'question') { q.textContent = m.text; a.textContent = ''; st.textContent = 'thinking…'; }
    else if (m.type === 'append') { a.textContent += m.text; window.scrollTo(0, document.body.scrollHeight); }
    else if (m.type === 'set') { a.textContent = m.text; st.textContent = 'done'; }
    else if (m.type === 'status') { st.textContent = m.text; }
  });
</script>
</body></html>`
  }
}
