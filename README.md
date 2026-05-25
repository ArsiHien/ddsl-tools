# DDSL Tools

VS Code client/UI extension for [DDSL](https://github.com/ArsiHien/ddsl). It adds editor support for `.ddsl` files, starts the DDSL language server, exposes compile and AI-generation commands, and renders Mermaid diagrams in a VS Code webview.

## Features

- DDSL language registration for `.ddsl` files
- Language Server Protocol integration with `ddsl-lsp`
- Commands to compile DDSL and generate diagrams
- AI-assisted DDSL generation through a configurable HTTP API
- Compile and AI diff artifacts under `.ddsl-output` by default

## Prerequisites

- Node.js and npm
- VS Code `^1.110.0`
- The DDSL language server from [ArsiHien/ddsl](https://github.com/ArsiHien/ddsl)

For normal extension use, place the language server binary at:

```text
bin/ddsl-lsp
```

On Windows, use:

```text
bin/ddsl-lsp.exe
```

The `bin/` directory is ignored by git, so the binary must be copied in manually or provided by release automation.

## Install Dependencies

```bash
npm install
```

## Run Locally

1. Build the extension:

   ```bash
   npm run compile
   ```

2. Open this folder in VS Code.
3. Press `F5` or run `Debug: Start Debugging`.
4. In the Extension Development Host window, open a `.ddsl` file.

The extension activates when a `.ddsl` file is opened.

## Development Server Mode

For local DDSL server development, create a `.env` file in this project or in the opened workspace:

```bash
ENV=dev
```

In `ENV=dev`, the extension launches a local Java LSP jar instead of `bin/ddsl-lsp`. See `src/lsp.ts` for the configured jar path.

## Useful Commands

```bash
npm run check-types
npm run lint
npm run compile
npm run package
npm run watch
npm test
```

`npm run compile` and `npm run package` both run type checking and linting before bundling `dist/extension.js`.

## Deploy / Package

Build the production bundle:

```bash
npm run package
```

Create a VSIX package:

```bash
npx @vscode/vsce package
```

Install the generated `.vsix` in VS Code:

```bash
code --install-extension ddsl-tools-0.0.1.vsix
```

Before packaging for users, make sure the `bin/ddsl-lsp` binary is included in the extension folder.

## Extension Settings

- `ddsl.compile.outputDir`: output directory for compile artifacts and AI diff snapshots. Default: `.ddsl-output`
- `ddsl.ai.apiUrl`: base URL of the AI service. Default: `http://localhost:8080`
- `ddsl.ai.timeoutMs`: AI API timeout in milliseconds. Default: `30000`
- `ddsl.ai.maxRetries`: AI API retry count. Default: `3`

## Commands

- `DDSL: Compile DDSL`
- `DDSL: Generate DDSL from Natural Language`
- `DDSL: Generate Diagram`
- `DDSL: Generate Component Diagram`
- `DDSL: Generate Event Flow Diagram`
