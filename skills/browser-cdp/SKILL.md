---
name: browser-cdp
description: Browser automation using Chrome DevTools Protocol (CDP), accessibility trees (cdp ax), and Slack communication tools.
autoLoad: true
---
# Browser Automation & Slack Communication Tools

You have access to dedicated CLI tools installed in `/usr/local/bin` for controlling Chrome via the Chrome DevTools Protocol (CDP), inspecting accessibility trees, capturing screenshots, and communicating via Slack.

## Chrome CDP Tools

All browser interactions are driven by `cdp` commands connecting to a headed Chrome instance running on display `:99`:

- `start-browser`: Ensure headed Chrome is running on display :99 with persistent profile and remote debugging (cleans locks automatically). Run this if the browser is closed or died.
- `cdp ax [max_depth]`: **ALWAYS RUN THIS FIRST AFTER NAVIGATING!** Dumps the accessibility tree with explicit `[@ref]` tags (e.g. `- button "Search" [@5]`, `- textbox "Zip" [@3]`).
- `cdp click <target>`: Click an element.
  - **Best target**: `@ref` (e.g. `cdp click @5`). 100% immune to substring collisions or selector ambiguity!
  - Alternative: `role:name` (e.g. `cdp click "button:Search"` or `cdp click "link:Searches"`).
  - Alternative: exact text (e.g. `cdp click "text=Search"`). Exact matches take priority over partial matches.
- `cdp type <target> <text>`: Focus element and type text (e.g. `cdp type @3 28601` or `cdp type "textbox:Zip" 28601`). Fully supports React and controlled inputs by invoking native property setters and triggering input/change events.
- `cdp select <target> <value>`: Select dropdown option in `<select>` elements by option value, exact text, or substring text (e.g. `cdp select @4 50`).
- `cdp press <key>`: Press a key: `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`, etc.
- `cdp goto <url> [--timeout ms]`: Navigate to a URL (default timeout: 15s).
- `cdp download <url> [--dir DIR] [--by-anchor] [--timeout ms]`: Download a web resource via Chrome with full cookie/session authentication. Files default to `~/workspace/downloads`. Use `--by-anchor` to force downloads of PDFs/PNGs that Chrome would otherwise render inline.
- `cdp snapshot [file.mhtml]`: Capture full page archive as MHTML.
- `cdp pdf [file.pdf]`: Print current page to PDF.
- `cdp scroll [up|down] [px]`: Scroll the page (default: 500px).
- `cdp wait-for <target>`: Wait until an element exists in the DOM.
- `cdp eval <js>`: Evaluate JavaScript expression in page context.
- `cdp screenshot [file.png]`: Capture a direct high-res screenshot of the active page via CDP.
- `cdp tabs`: List all open browser tabs with IDs and titles.
- `cdp switch-tab <id|index>`: Switch active tab.
- `cdp new-tab [url]`: Open a new tab (optionally navigating to URL).
- `cdp close-tab [id]`: Close a tab.
- `cdp wait-tab [query] [--timeout ms]`: Wait for a newly opened tab or popup from `window.open` / `<a target="_blank">`.
- `cdp reload`: Reload the active page.
- `cdp back` / `cdp forward`: Navigate browser history.

## Display & Screenshot Tools

- `view_image <file_path> [prompt]`: **Direct visual inspection tool!** Inspect any image or screenshot (PNG, JPG, WEBP) using the configured vision model. Ask specific questions like `view_image file_path="/tmp/screen.png" prompt="Is there a CAPTCHA or error message visible?"`.
- `screenshot [output.png] [url]`: Capture a screenshot of virtual display `:99` (or render a URL).
- `slack-screenshot [url] [comment]`: Take a screenshot and upload it directly to the active Slack thread in one step.

## Slack Communication Tools

- `slack-post <message>`: Post a progress update or message to the current Slack thread. For multi-step tasks, use this to keep the user informed of progress.
- `slack-upload <file> [comment]`: Upload a file, image, or document directly to the current Slack thread.
- `slack-read`: Read recent messages from the current Slack channel and thread.

## Browser Best Practices & Workflow

1. **Navigate and inspect**:
   ```bash
   cdp goto https://example.com
   cdp ax
   ```
2. **Target by `@ref`**:
   Examine the AX tree output. Look for lines like:
   `- textbox "Zip" [@2]`
   `- button "Search" [@4]`
   Use the `@ref` identifier directly:
   ```bash
   cdp type @2 28601
   cdp click @4
   ```
3. **Verify actions without eval**:
   After typing or clicking, run `cdp ax` to verify the state update (e.g. confirming input values or resulting search lists).
4. **Workspace & Execution Boundary**:
   - Your assigned workspace is `/home/node/workspace`. All file operations and shell commands must remain within `/home/node/workspace`.
   - Helper tools (`cdp`, `start-browser`, `screenshot`, etc.) are installed system-wide in `/usr/local/bin`.
