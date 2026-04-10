# AI Agent Monitor

> A VS Code extension that monitors AI agent panels and displays a live, structured feed of conversations.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.85.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Live Conversation Feed** — See user inputs, agent thinking, and agent output in real-time
- **Streaming Support** — Watch agent reasoning and responses appear character-by-character
- **Token Counting** — Approximate token counts displayed for each message block
- **Multi-Tool Monitoring** — Detects activity from Cursor AI, GitHub Copilot, Continue, Cline, Cody, Antigravity, and more
- **Extension API** — Other extensions can push messages into the monitor programmatically
- **Theme-Aware** — Adapts to VS Code light and dark themes automatically
- **Built-in Demo** — Run a live demo to see the monitor in action

## Quick Start

### Install from VSIX

```bash
# Build and install locally
npm install
npm run install:local
```

Then open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:
- **AI Agent Monitor: Open Panel**
- **AI Agent Monitor: Run Demo** (to see it in action)

### Keyboard Shortcut

`Cmd+Shift+M` / `Ctrl+Shift+M` — Open the monitor panel

## How It Works

### Output Channel Monitoring
The extension watches VS Code output channels for AI tool activity. When an output channel named "Cursor", "Copilot", "Continue", etc. is visible, the monitor captures and parses its content.

### Command API
Other extensions can push messages directly:

```typescript
// Push a complete message
vscode.commands.executeCommand(
  'aiAgentMonitor.pushMessage',
  'user-input',       // type: 'user-input' | 'agent-thinking' | 'agent-output'
  'Hello, AI!',       // content
  'My Extension'      // source label (optional)
);
```

### Extension API
Extensions can also use the exported API for streaming support:

```typescript
const monitorExt = vscode.extensions.getExtension('ameyakulkarni.ai-agent-monitor');
const api = monitorExt?.exports;

if (api) {
  // Start a streaming block
  const blockId = api.startStreamingBlock('agent-output', 'My Tool');

  // Append text incrementally
  api.appendToBlock(blockId, 'Hello ');
  api.appendToBlock(blockId, 'world!');

  // Mark as complete
  api.completeBlock(blockId);
}
```

## Commands

| Command | Description |
|---------|-------------|
| `AI Agent Monitor: Open Panel` | Open the monitor WebView panel |
| `AI Agent Monitor: Run Demo` | Run a live streaming demo |
| `AI Agent Monitor: Push Message` | Manually push a message (interactive) |
| `AI Agent Monitor: Clear History` | Clear the conversation feed |

## Display Format

```
👤 User Input (42 tokens):
[the actual user message here]

🧠 Agent Thinking (118 tokens):
[the agent's chain-of-thought / reasoning]

🤖 Agent Output (305 tokens):
[the agent's final response]

─────── new turn ───────

👤 User Input (17 tokens):
[next user message...]
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (rebuild on changes)
npm run watch

# Type-check
npm run lint

# Package as VSIX
npm run package

# Build, package, and install locally
npm run install:local
```

## Project Structure

```
ai-agent-monitor/
├── src/
│   ├── extension.ts      # Entry point, commands, API
│   ├── MonitorPanel.ts    # WebView panel & UI
│   ├── AgentMonitor.ts    # Monitoring engine
│   └── types.ts           # Shared type definitions
├── dist/                  # Bundled output (generated)
├── media/                 # Static assets
├── package.json
├── tsconfig.json
├── esbuild.js
└── README.md
```

## License

MIT
