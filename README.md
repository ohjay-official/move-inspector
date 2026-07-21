# Move Inspector

Point it at any Sui **package or object**. Get its module/function structure (or decoded object fields), plus a heuristic access-control scan — straight off the public RPC. No indexer, no backend, no setup.

Built for **Sui Overflow 2026 — Infra & DevX track**.

Three ways to use it:

1. **Web app** — a single static HTML file, live-queries Sui's RPC from your browser.
2. **CLI** — the same scan, runnable in a terminal (`npx` or `node cli.js`).
3. **GitHub Action** — drop the same scan into your CI pipeline so a privileged-looking public function with no capability check fails the build, not a post-mortem.

All three share the exact same heuristic logic, so what you see on the web matches what your CI enforces.

---

## 1. Web app

Open `index.html` directly, or visit the deployed URL. No build step, no dependencies — it's one file that calls Sui's public JSON-RPC directly from the browser.

- Paste any package ID → module/function/struct breakdown + access-control flags
- Paste any object ID → decoded fields, owner, version, type
- Switch mainnet / testnet / devnet — the whole UI retints so it's obvious which chain you're looking at
- Every scan gets a shareable link: `?pkg=0x...&net=mainnet`
- Export any scan as a Markdown report

## 2. CLI

Zero dependencies — uses Node's built-in `fetch` (Node 18+).

```bash
node cli.js 0x2 --network mainnet
```

```bash
# JSON output, for piping into other tools
node cli.js 0xdee9 --network mainnet --json

# Don't fail the process even if warnings are found
node cli.js 0x2 --no-fail
```

**Exit codes:** `0` clean scan · `1` at least one WARN-level flag (useful for CI gating) · `2` request failed.

Once published to npm, this becomes `npx move-inspector <package-id>`. Until then, clone the repo and run `node cli.js` directly, or `npm link` locally for a `move-inspector` command on your PATH.

## 3. GitHub Action

Drop this into any repo's workflow to scan a deployed package on every push or PR:

```yaml
- uses: <your-github-username>/move-inspector@main
  with:
    package-id: '0xYOUR_PACKAGE_ID'
    network: 'mainnet'      # or testnet / devnet
    fail-on-warn: 'true'    # fail the job if a WARN-level flag is found
```

Results are written to the job's step summary, so reviewers see the scan output directly in the PR checks — no separate tool to open.

This repo includes a working example at [`.github/workflows/self-test.yml`](.github/workflows/self-test.yml) that scans the Sui framework package (`0x2`) on every push — check the Actions tab for a live passing run.

---

## What the heuristic scan actually checks

Pattern-based, not a substitute for an audit:

- **Privileged-looking public functions with no capability param** — a `public` function named like `mint_`, `admin_`, `upgrade_`, `freeze_`, `pause_`/`unpause_`, `init_admin`, or `transfer_ownership` that takes no capability-style parameter (`Cap`, `Admin`, `Owner`, `Witness`, `Publisher`, `Ticket`, `Receipt`, `Proof`, `Permit`) gets flagged. The verb list is intentionally narrow and high-signal — generic Move primitives like `add_`/`remove_`/`set_`/`update_` were deliberately left out after testing against Sui's own framework package (`0x2`) surfaced them as noise, not real signal.
  - **Known limitation:** some Sui functions are gated by Move's bytecode verifier itself rather than a capability parameter — e.g. `transfer::freeze_object<T: key>(obj: T)` only accepts a type `T` defined in the calling module, which isn't visible from the normalized function signature the RPC returns. This class of protection will still show up as a false flag. Verified against `0x2` directly — see commit history for the before/after.
- **`key`-only structs** (no `store`) — flagged as informational; can't be wrapped in other objects or moved with generic transfer functions.
- **All-public-no-entry packages** — informational note that functions are only reachable from Move/PTBs, not directly from a wallet.

## How it works technically

- Package scans call `sui_getNormalizedMoveModulesByPackage` — Sui's fullnode already returns fully structured module/function/struct data, so there's no bytecode disassembly or indexer needed.
- Object scans call `sui_getObject` with content/owner/type flags, and branch on the returned `dataType` (`package` vs `moveObject`) to decide which view to render.
- All three surfaces (web, CLI, Action) share the same `typeToString`/`buildChecklist` logic, kept in sync by hand since the CLI has no bundler step.

## Privacy

Reads are unauthenticated calls to Sui's public JSON-RPC. Nothing is stored server-side — the web app has no backend at all.
