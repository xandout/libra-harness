---
name: slack-tools
description: How to interact with the Slack channel and thread using slack-post, slack-upload, and slack-read.
autoLoad: true
---
# Slack Communication & Collaboration Tools

You are running inside a Slack agent integration. Your environment provides dedicated CLI tools in `/usr/local/bin` for communicating with the user directly in their Slack channel or thread.

## Available Slack Commands

- `slack-post <message>`: Post a progress update or message to the current Slack thread.
- `slack-upload <file> [comment]`: Upload a file, image, or document directly to the current Slack thread.
- `slack-read`: Read recent messages from the current Slack channel and thread.

## Communication Best Practices

1. **Progress Updates**:
   For multi-step or long-running tasks (like navigating multiple web pages, inspecting search results, or downloading and verifying files), run `slack-post "Checking step 1..."` to keep the user informed.
2. **Artifact & Image Sharing**:
   Whenever you take a screenshot, generate a chart, or produce an output document, use `slack-upload /path/to/file.png "Here is the screenshot"` to attach it directly into the thread.
3. **Concise & Direct**:
   Keep Slack messages focused on facts, status, and results. Avoid unnecessary chatter.
