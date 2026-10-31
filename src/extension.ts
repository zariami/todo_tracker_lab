import * as vscode from 'vscode';

interface TodoItem {
  uri: vscode.Uri;
  line: number;
  keyword: string;
  text: string;
}

type TodoNode = FileNode | ItemNode;

class FileNode extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri, public readonly items: TodoItem[]) {
    super(vscode.workspace.asRelativePath(uri), vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = uri;
    this.description = String(items.length);
    this.contextValue = 'file';
  }
}

class ItemNode extends vscode.TreeItem {
  constructor(public readonly item: TodoItem) {
    super(`${item.keyword}: ${item.text}`, vscode.TreeItemCollapsibleState.None);
    this.description = `строка ${item.line + 1}`;
    this.iconPath = new vscode.ThemeIcon(iconFor(item.keyword));
    this.command = {
      command: 'todoTracker.openItem',
      title: 'Открыть',
      arguments: [item],
    };
  }
}

function iconFor(keyword: string): string {
  switch (keyword.toUpperCase()) {
    case 'TODO':
      return 'checklist';
    case 'FIXME':
      return 'bug';
    case 'HACK':
      return 'warning';
    default:
      return 'note';
  }
}

class TodoProvider implements vscode.TreeDataProvider<TodoNode> {
  private readonly emitter = new vscode.EventEmitter<TodoNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private byFile = new Map<string, FileNode>();
  total = 0;

  setItems(items: TodoItem[]): void {
    const groups = new Map<string, TodoItem[]>();
    for (const item of items) {
      const key = item.uri.toString();
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    this.byFile = new Map();
    for (const [key, list] of groups) {
      this.byFile.set(key, new FileNode(list[0].uri, list));
    }
    this.total = items.length;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TodoNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TodoNode): TodoNode[] {
    if (!element) {
      return [...this.byFile.values()].sort((a, b) =>
        a.label!.toString().localeCompare(b.label!.toString())
      );
    }
    if (element instanceof FileNode) {
      return element.items.map((i) => new ItemNode(i));
    }
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(keywords: string[], flags = ''): RegExp {
  const words = keywords.map(escapeRegExp).join('|');
  return new RegExp(`(?:\\/\\/|#|\\/\\*+|\\*|<!--|--|%)\\s*(${words})\\b:?\\s*(.*)`, flags);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('todoTracker');
  return {
    keywords: cfg.get<string[]>('keywords', ['TODO', 'FIXME', 'HACK']),
    include: cfg.get<string>('include', '**/*'),
    exclude: cfg.get<string>('exclude', '**/node_modules/**'),
    maxFiles: cfg.get<number>('maxFiles', 2000),
    scanOnSave: cfg.get<boolean>('scanOnSave', true),
    highlight: cfg.get<boolean>('highlight', true),
  };
}

function cleanText(text: string): string {
  return text.replace(/\s*(\*\/|-->)\s*$/, '').trim();
}

async function scanWorkspace(): Promise<TodoItem[]> {
  const cfg = getConfig();
  if (cfg.keywords.length === 0) {
    return [];
  }
  const regex = buildRegex(cfg.keywords);
  const files = await vscode.workspace.findFiles(cfg.include, cfg.exclude, cfg.maxFiles);
  const decoder = new TextDecoder('utf-8');
  const result: TodoItem[] = [];

  for (const uri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const lines = decoder.decode(bytes).split(/\r?\n/);
      lines.forEach((lineText, index) => {
        const m = regex.exec(lineText);
        if (m) {
          result.push({ uri, line: index, keyword: m[1], text: cleanText(m[2]) });
        }
      });
    } catch {
    }
  }
  return result;
}

const highlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 200, 0, 0.25)',
  fontWeight: 'bold',
  overviewRulerColor: 'rgba(255, 200, 0, 0.8)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

function updateHighlight(editor: vscode.TextEditor | undefined): void {
  if (!editor) {
    return;
  }
  const cfg = getConfig();
  if (!cfg.highlight || cfg.keywords.length === 0) {
    editor.setDecorations(highlightDecoration, []);
    return;
  }
  const regex = buildRegex(cfg.keywords);
  const ranges: vscode.Range[] = [];
  for (let i = 0; i < editor.document.lineCount; i++) {
    const text = editor.document.lineAt(i).text;
    const m = regex.exec(text);
    if (m) {
      const start = m.index + m[0].indexOf(m[1]);
      ranges.push(new vscode.Range(i, start, i, start + m[1].length));
    }
  }
  editor.setDecorations(highlightDecoration, ranges);
}

function commentTemplate(languageId: string, keyword: string): { before: string; after: string } {
  switch (languageId) {
    case 'python':
    case 'ruby':
    case 'shellscript':
    case 'yaml':
      return { before: `# ${keyword}: `, after: '' };
    case 'html':
    case 'xml':
    case 'markdown':
      return { before: `<!-- ${keyword}: `, after: ' -->' };
    case 'css':
    case 'scss':
      return { before: `/* ${keyword}: `, after: ' */' };
    default:
      return { before: `// ${keyword}: `, after: '' };
  }
}

async function addTodo(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('TODO Tracker: откройте файл в редакторе.');
    return;
  }
  const keywords = getConfig().keywords;
  const keyword =
    keywords.length > 1
      ? await vscode.window.showQuickPick(keywords, { placeHolder: 'Выберите тип заметки' })
      : keywords[0];
  if (!keyword) {
    return;
  }

  const line = editor.selection.active.line;
  const lineText = editor.document.lineAt(line);
  const indent = lineText.text.match(/^\s*/)?.[0] ?? '';
  const tpl = commentTemplate(editor.document.languageId, keyword);

  await editor.edit((edit) => {
    edit.insert(lineText.range.end, `\n${indent}${tpl.before}${tpl.after}`);
  });

  const col = indent.length + tpl.before.length;
  const pos = new vscode.Position(line + 1, col);
  editor.selection = new vscode.Selection(pos, pos);
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('Расширение "todo-tracker-lab" активировано');

  const provider = new TodoProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'todoTracker.view.focus';
  statusBar.tooltip = 'Показать список TODO';
  statusBar.text = '$(checklist) TODO: …';
  statusBar.show();

  let scanning = false;
  const runScan = async () => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'TODO Tracker: сканирование' },
        async () => {
          const items = await scanWorkspace();
          provider.setItems(items);
          statusBar.text = `$(checklist) TODO: ${provider.total}`;
        }
      );
    } finally {
      scanning = false;
    }
  };

  context.subscriptions.push(
    statusBar,
    highlightDecoration,
    vscode.window.registerTreeDataProvider('todoTracker.view', provider),

    vscode.commands.registerCommand('todoTracker.scan', async () => {
      await runScan();
      vscode.window.showInformationMessage(`TODO Tracker: найдено заметок — ${provider.total}`);
    }),
    vscode.commands.registerCommand('todoTracker.addTodo', addTodo),
    vscode.commands.registerCommand('todoTracker.openItem', async (item: TodoItem) => {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const range = new vscode.Range(item.line, 0, item.line, 0);
      await vscode.window.showTextDocument(doc, { selection: range });
    }),

    vscode.window.onDidChangeActiveTextEditor(updateHighlight),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === e.document) {
        updateHighlight(editor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      if (getConfig().scanOnSave) {
        void runScan();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('todoTracker')) {
        void runScan();
        vscode.window.visibleTextEditors.forEach(updateHighlight);
      }
    })
  );

  updateHighlight(vscode.window.activeTextEditor);
  void runScan();
}

export function deactivate(): void {
  console.log('Расширение "todo-tracker-lab" деактивировано');
}
