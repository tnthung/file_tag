# File Tag

A VS Code extension that lets you tag files and directories using glob patterns, then create filtered views with logical conditions to browse only the files you care about.

## Features

- **Tags** — group files with glob patterns (supports wildcards)
- **Views** — define named views using logical conditions over tags (`and`, `or`, `not`)
- **Side panel** — browse view files in a nested tree, just like the Explorer
- **Editor sync** — active file is automatically revealed in the panel
- **Search in view** — scope VS Code's built-in search to the current view's files
- **Tag preview** — temporarily browse a single tag without creating a view
- **Persistent view** — last opened view is restored on startup

## Getting Started

1. Open a workspace folder
2. Click the **File Tag** icon in the activity bar
3. Right-click **Tags** → **Create Tag** to add your first tag
4. Right-click a tag → **Add Pattern** to add a glob pattern
5. Click **New View from Tags** (+ on the Views header) to create a view
6. Click a view to browse its files

## Configuration

Config is stored at `.vscode/file-tag.json` and auto-reloads on save.

```json
{
  "tags": {
    "frontend": [
      "${workspaceFolder}/src/**/*.tsx",
      "${workspaceFolder}/src/**/*.css"
    ],
    "backend": [
      "${workspaceFolder}/server/**/*.ts"
    ],
    "tests": [
      "${workspaceFolder}/**/*.test.ts"
    ]
  },
  "views": {
    "Frontend": "frontend",
    "Backend only": { "and": ["backend", { "not": "tests" }] },
    "All source": ["frontend", "backend"]
  }
}
```

### Glob patterns

Patterns support VS Code's standard variable syntax as a prefix:

| Variable | Resolves to |
|----------|-------------|
| `${workspaceFolder}` | First/only workspace folder |
| `${workspaceFolder:Name}` | Named workspace folder (multi-root) |
| `${userHome}` | User home directory |
| `${env:VAR}` | Environment variable (must be an absolute path) |

Standard glob wildcards apply:

| Pattern | Matches |
|---------|---------|
| `${workspaceFolder}/src/**/*.ts` | All `.ts` files under `src/` |
| `${workspaceFolder}/src/*.ts` | `.ts` files directly in `src/` |
| `${workspaceFolder}/**/*.{ts,tsx}` | All `.ts` and `.tsx` files |
| `${userHome}/.config/**` | All files under `~/.config/` |

### View conditions

| Condition | Example | Meaning |
|-----------|---------|---------|
| `string` | `"frontend"` | All files in tag |
| `string[]` | `["frontend", "backend"]` | Union of tags |
| `{ and: [...] }` | `{ "and": ["frontend", "backend"] }` | Intersection |
| `{ or: [...] }` | `{ "or": ["frontend", "backend"] }` | Union |
| `{ not: ... }` | `{ "not": "tests" }` | All files except tag |

Conditions can be nested to any depth.

## Panel Toolbar

| Button | Action |
|--------|--------|
| `$(notebook-revert)` Browse | Return to view/tag selection |
| `$(collapse-all)` Collapse All | Collapse all expanded folders |
| `$(search)` Search | Search within current view's files |
| `$(gear)` Open Config | Open `.vscode/file-tag.json` |
| `$(refresh)` Refresh | Reload tags and views from config |

The Browse, Collapse, and Search buttons appear when a view is active. Open Config and Refresh appear in selection mode.

## Context Menu

Right-clicking items in the panel exposes actions:

**Views** — Edit, Rename, Delete

**Tags** — Preview, Add Pattern, Rename, Delete

**Patterns** — Delete Pattern

**Files / Directories** — Open to Side, Reveal in Explorer, Reveal in OS, Open in Terminal, Copy, Paste, Duplicate, Copy Path, Copy Relative Path, Rename, Delete
