---
name: macos-root
description: Run commands as root on this Mac via osascript "do shell script ... with administrator privileges", because sudo cannot prompt for a password in opencode. Use whenever a task needs root/sudo/admin privileges, sudo fails with "a password is required", or the task touches root-owned config, LaunchDaemons, /usr/local, or other privileged paths.
---

# Privilege Escalation on macOS (sudo vs osascript)

In this opencode environment, `sudo` cannot prompt for a password — there's no controlling TTY and no askpass helper, so any plain `sudo ...` call fails with `sudo: a password is required`. Don't keep retrying sudo or pretend it'll work eventually.

When you need root on this Mac, use `osascript` with administrator privileges instead. It pops a native macOS authorization dialog (or Touch ID, if `pam_tid` is enabled for SecurityAgent) and runs the command as root via Authorization Services.

```bash
osascript -e 'do shell script "your-command-here" with administrator privileges'
```

## Rules and gotchas

- The shell inside `do shell script ... with administrator privileges` already runs as **root**. Do NOT add `sudo` inside it — it's redundant.
- Without `with administrator privileges`, the shell runs as the user, and `sudo` inside will fail for the same TTY reason as before. Always include the clause.
- Each `osascript` invocation triggers its own auth prompt. To minimize prompts, **batch the work**: write a single shell script to the pre-approved opencode temp directory (the `/var/folders/.../T/opencode` path named in your system prompt), `chmod +x` it, and run the whole script through one `osascript` call.
- This requires Max to be physically at the Mac to approve the dialog. It is not suitable for unattended automation — if you'd be blocked on the prompt, say so and stop instead of waiting indefinitely.
- For non-trivial root operations (editing root-owned config, restarting LaunchDaemons, installing into `/usr/local/`, etc.), prefer staging the changes into the opencode temp directory first, then have the elevated script copy/install them. Easier to review the diff before approving the prompt.
- When a fallback path exists (write a file under the opencode temp directory and give Max the `sudo` commands to run himself), that's also valid — use it when the change is one-shot and trivial, or when Max has said he'd run the commands.
