import { CdpClient } from './client.js';
import { getActivePageTarget } from './utils.js';
import * as commands from './commands/index.js';

async function main() {
  const args = process.argv.slice(2);
  let cmd = args[0];

  if (cmd === 'shot') cmd = 'screenshot';
  if (cmd === 'ls-tabs' || cmd === 'list-tabs') cmd = 'tabs';
  if (cmd === 'new') cmd = 'new-tab';

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`Usage: cdp <command> [args]

Inspection & Semantic Tree:
  ax [max_depth]                 Dump clean accessibility tree with [@ref] tags (default depth: 8)
  title                          Print document.title
  url                            Print current URL
  eval <js>                      Evaluate JavaScript in the page context
  screenshot [file.png]          Capture crisp page screenshot via CDP (alias: shot)
  snapshot [file.mhtml]          Capture full page archive as MHTML
  pdf [file.pdf]                 Print page to PDF

Interaction:
  click <target>                 Click an element. Target can be:
                                   - AX Ref tag:       cdp click @3   (or: cdp click 3)
                                   - Role + Name:      cdp click "button:Search" or "role=button name=Search"
                                   - Accessible Text:  cdp click "text=Search" (exact match first!)
                                   - CSS Selector:     cdp click "#subBtn" or "input[type=submit]"
  type <target> <text>           Focus element and type text (supports React/controlled inputs & standard inputs)
  select <target> <value>        Select dropdown option by value or text in <select> elements
  press <key>                    Press key: Enter, Tab, Escape, Backspace, ArrowDown, etc.
  scroll [up|down] [amount]      Scroll page up or down (default: 500px)
  wait-for <target>              Wait until element appears in DOM

Navigation & Downloads:
  goto <url> [--timeout ms]      Navigate active tab to URL (default timeout: 15s)
  download <url> [opts]          Download file via Chrome. Options:
                                   --dir <dir>         Download directory (default: workspace/downloads)
                                   --timeout <ms>      Download timeout (default: 60000ms)
                                   --by-anchor         Synthesize <a download> click to force download
  reload                         Reload active page
  back                           Go back in history
  forward                        Go forward in history

Tab Management:
  tabs                           List all open browser tabs (alias: ls-tabs)
  new-tab [url]                  Open a new tab (alias: new; default: about:blank)
  switch-tab <id|index>          Switch active tab by ID or list index (0, 1, ...)
  close-tab [id]                 Close a tab (default: active tab)
  wait-tab [query] [--timeout ms] Wait for a new tab matching title/url query (or new tab count)
`);
    process.exit(0);
  }

  // ── Tab management commands (do not require an existing connected page) ──
  if (cmd === 'tabs') return commands.tabsCommand();
  if (cmd === 'new-tab') return commands.newTabCommand(args);
  if (cmd === 'switch-tab') return commands.switchTabCommand(args);
  if (cmd === 'close-tab') return commands.closeTabCommand(args);
  if (cmd === 'wait-tab') return commands.waitTabCommand(args);
  if (cmd === 'download') return commands.downloadCommand(args);

  // ── Page-level commands: connect WebSocket to active tab ──
  let page;
  try {
    page = await getActivePageTarget();
  } catch (err: any) {
    console.error('Failed to connect to Chrome CDP:', err.message);
    process.exit(1);
  }

  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();

  try {
    if (cmd === 'goto') {
      await commands.gotoCommand(client, args);
    } else if (cmd === 'snapshot') {
      await commands.snapshotCommand(client, args);
    } else if (cmd === 'pdf') {
      await commands.pdfCommand(client, args, page.id);
    } else if (cmd === 'ax') {
      await commands.axCommand(client, args);
    } else if (cmd === 'press') {
      await commands.pressCommand(client, args);
    } else if (cmd === 'screenshot') {
      await commands.screenshotCommand(client, args);
    } else if (cmd === 'reload') {
      await commands.reloadCommand(client);
    } else if (cmd === 'back' || cmd === 'forward') {
      await commands.historyCommand(client, cmd);
    } else if (cmd === 'title') {
      await commands.titleCommand(client);
    } else if (cmd === 'url') {
      await commands.urlCommand(client);
    } else if (cmd === 'click') {
      await commands.clickCommand(client, args);
    } else if (cmd === 'type') {
      await commands.typeCommand(client, args);
    } else if (cmd === 'select') {
      await commands.selectCommand(client, args);
    } else if (cmd === 'select-all') {
      await commands.selectAllCommand(client, args);
    } else if (cmd === 'scroll') {
      await commands.scrollCommand(client, args);
    } else if (cmd === 'wait-for') {
      await commands.waitForCommand(client, args);
    } else if (cmd === 'eval') {
      await commands.evalCommand(client, args);
    } else {
      console.error(`Unknown command: ${cmd}. Run "cdp help" for usage.`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
    process.exit(0);
  }
}

main();
