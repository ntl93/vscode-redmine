# `vscode-redmine`

Redmine extension for Visual Studio Code.

## Features

- Sidebar panel
  - List issues assigned to you in sidebar panel
  - List projects and open issues in them
- Create issue (opens redmine create issue in browser)
- List of issues assigned to you
- Open issue by id
- Open issue by selected number in document
- Issue actions:
  - Change status of an issue
  - Add time entry to an issue
  - Open issue in browser
  - Quick update issue

_Missing a feature? Open an [issue](https://github.com/ntl93/vscode-redmine/issues) and let us know!_

### Sidebar panel

![Sidebar panel GIF showcase](./resources/redmine-sidebar-panel.gif)

### Add time entry from action menu

![Add time entry from action menu GIF showcase](./resources/redmine-add-time-entry.gif)

### Change server to other workspace folder in sidebar panel

![Change server to other workspace folder in sidebar panel GIF showcase](./resources/redmine-change-sidebar-server.gif)

## Requirements

It's required to enable REST web services in `/settings?tab=api` of your redmine (you have to be administrator of redmine server).

## Extension Settings

This extension contributes the following settings:

- `redmine.url`: URL of redmine server (eg. `https://example.com`, `http://example.com:8080`, `https://example.com:8443/redmine`, `http://example.com/redmine` _etc._)
- `redmine.apiKey`: API Key of your redmine account (see `/my/account` page, on right-hand pane)
- `redmine.rejectUnauthorized`: Parameter, which is passed to https request options (true/false) (useful to fix issues with self-signed certificates, see issue #3)
- `redmine.identifier`: If set, this will be the project, to which new issue will be created

  _NOTE: this is an identifier of project, not display name of the project_

- `redmine.additionalHeaders`: Object of additional headers to be sent along with every request to redmine server

## Contribution

If you want to contribute to the project, please read the [contributing guide](./CONTRIBUTING.md).

## Development

### Prerequisites

- Node.js (LTS recommended)
- VS Code

### Install dependencies

```bash
npm ci
```

### Run / debug in VS Code

1. Open this repository in VS Code.
2. Press `F5` (or use **Run and Debug** → **Run Extension**).
3. A new **Extension Development Host** window opens with the extension loaded.

The extension can be configured in the Extension Development Host window via workspace settings:

- `redmine.url`
- `redmine.apiKey`

### Build

```bash
npm run compile
```

### Watch mode

```bash
npm run watch
```

### Lint

```bash
npm run lint
```

## Packaging & publishing

This extension uses VS Code's standard `vsce` tooling.

### Package a `.vsix`

```bash
npx @vscode/vsce package
```

This produces a `vscode-redmine-*.vsix` file.

### Install on another machine

- In VS Code: **Extensions** → `...` (More Actions) → **Install from VSIX...**
- Or from CLI:

```bash
code --install-extension ./vscode-redmine-*.vsix
```

### Publish

```bash
npx @vscode/vsce publish
```

## Known Issues

No known issues yet. If you found one, feel free to [open an issue](https://github.com/ntl93/vscode-redmine/issues)!

## Release Notes

See [change log](./CHANGELOG.md)

## Attributions

### Logo

Logo is remixed version of original Redmine Logo.

Redmine Logo is Copyright (C) 2009 Martin Herr and is licensed under the Creative Commons Attribution-Share Alike 2.5 Generic license.
See http://creativecommons.org/licenses/by-sa/2.5/ for more details.

---

> This project is a fork of [rozpuszczalny/vscode-redmine](https://github.com/rozpuszczalny/vscode-redmine). Thanks to the original author and all contributors!
