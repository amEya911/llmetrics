import * as vscode from 'vscode';
import { AgentMonitor } from './AgentMonitor';
import { MonitorPanel } from './MonitorPanel';
import { SidebarProvider } from './SidebarProvider';
import { BlockType } from './types';

let monitor: AgentMonitor | undefined;
let sidebarProvider: SidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  monitor = new AgentMonitor();
  context.subscriptions.push(monitor);

  sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  sidebarProvider.sync(monitor.getTurns(), monitor.getStatus());

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.open', () => {
      const panel = MonitorPanel.createOrShow(context.extensionUri);
      panel.sync(monitor!.getTurns(), monitor!.getStatus());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.ai-agent-monitor');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.clear', () => {
      monitor!.clearBlocks();
      sidebarProvider?.clear();
      MonitorPanel.getInstance()?.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'aiAgentMonitor.pushMessage',
      (type?: BlockType, content?: string, source?: string) => {
        if (!type || !content) {
          return;
        }

        const turn = monitor!.pushMessage({ type, content, source });
        sidebarProvider?.updateTurn(turn);
        MonitorPanel.getInstance()?.updateTurn(turn);
      }
    )
  );

  monitor.onTurnAdded((turn) => {
    sidebarProvider?.updateTurn(turn);
    MonitorPanel.getInstance()?.updateTurn(turn);
  });

  monitor.onTurnUpdated((turn) => {
    sidebarProvider?.updateTurn(turn);
    MonitorPanel.getInstance()?.updateTurn(turn);
  });

  monitor.onStatusChanged((status) => {
    sidebarProvider?.setStatus(status.status, status.text);
    MonitorPanel.getInstance()?.setStatus(status.status, status.text);
  });

  return {
    getTurns: () => monitor?.getTurns() ?? [],
    openPanel: () => vscode.commands.executeCommand('aiAgentMonitor.open'),
    openSidebar: () => vscode.commands.executeCommand('aiAgentMonitor.openSidebar'),
    pushMessage: (type: BlockType, content: string, source?: string) => {
      return monitor?.pushMessage({ type, content, source });
    },
  };
}

export function deactivate() {
  monitor?.dispose();
  monitor = undefined;
}
