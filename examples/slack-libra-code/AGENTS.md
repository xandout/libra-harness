# Agent Instructions: Browser & Slack Automation Environment

This environment provides a persistent headless/virtual desktop workspace equipped with Google Chrome, Chrome DevTools Protocol (CDP) control, and Slack integration tools.

---

## 1. Browser Automation Architecture

- **Display**: Virtual X11 server running on `:99` (1920x1080).
- **Browser**: Google Chrome running on `:99` with remote debugging enabled on port `18800`.
- **User Profile**: Persistent profile stored at `/home/node/chrome-profile`.

### Golden Rule: Never Run Raw `google-chrome &`
Always use `start-browser` to ensure Chrome is running with the proper remote debugging port, display settings, and automatic lock cleanup.

```bash
# Check or start Chrome
start-browser
```

---

## 2. CDP Tool Guide (`cdp`)

The `cdp` utility communicates directly with Chrome's DevTools Protocol WebSocket. It is much faster, more reliable, and cleaner than simulating mouse coordinates or parsing raw HTML.

### Semantic Inspection (The Accessibility Tree)
Instead of dumping megabytes of DOM or guessing CSS selectors, inspect the page using the accessibility tree:

```bash
# Dump the semantic tree (roles, labels, inputs)
cdp ax

# Inspect deeper if needed (default depth: 6)
cdp ax 10
```

The output gives you exact roles and labels:
```text
- RootWebArea "GitHub"
  - link "Sign in"
  - textbox "Search GitHub" [value: ""]
  - button "Search"
```

### Navigation & Tab Management
```bash
# Navigate active tab
cdp goto "https://news.ycombinator.com"

# Reload or history navigation
cdp reload
cdp back
cdp forward

# Tab management (essential for links that open in new tabs)
cdp tabs                  # List all open tabs with indexes and titles
cdp switch-tab 1          # Switch active tab to index 1
cdp new-tab "https://..." # Open a new tab
cdp close-tab             # Close the active tab
```

### Interacting with Elements
```bash
# Click by text or selector
cdp click "text=Submit"
cdp click "button.primary"
cdp click "#login-button"

# Typing and keyboard control
cdp type "input[name='q']" "search query"
cdp press Enter           # Submit search or form
cdp press Tab             # Move focus
cdp press Escape          # Dismiss modals or popups

# Scrolling
cdp scroll down 500       # Scroll down 500px
cdp scroll up 300         # Scroll up 300px

# Waiting and evaluation
cdp wait-for ".results-loaded"
cdp eval "document.title"
```

### Capturing Screenshots
```bash
# Direct high-res page screenshot via CDP (no window borders/X11 desktop)
cdp screenshot /tmp/page.png
```

---

## 3. Slack Integration Tools

When performing work requested via Slack, keep the user informed and share artifacts directly:

```bash
# Post a progress update during long multi-step tasks
slack-post "Browsing to the product page..."

# Upload an image or file to the current Slack thread
slack-upload /tmp/page.png "Screenshot of the dashboard"

# Take a screenshot of the virtual screen and upload in one command
slack-screenshot screen "Current desktop state"

# Read recent conversation context from the current thread
slack-read 10
```

---

## 4. Standard Workflow Example

When asked to automate a task on the web (e.g. "Go to site X and check Y"):

1. Ensure the browser is ready:
   ```bash
   start-browser
   ```
2. Navigate to the target page:
   ```bash
   cdp goto "https://example.com"
   ```
3. Read the semantic structure:
   ```bash
   cdp ax
   ```
4. Perform actions using clean selectors or text:
   ```bash
   cdp click "text=Sign In"
   cdp type "input#email" "user@example.com"
   cdp press Enter
   ```
5. Confirm results, take a screenshot, and report to Slack:
   ```bash
   cdp screenshot /tmp/result.png
   slack-upload /tmp/result.png "Here is the completed page"
   ```
