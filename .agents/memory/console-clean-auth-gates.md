---
name: Console-clean auth gates
description: Client pages must decide from the public identity route before calling a gated API, or signed-out visitors see console 401s.
---

# Console-clean auth gates

A page that shows a "log in" notice by *calling a protected route and catching
the 401* renders correctly but makes every signed-out visitor's browser log a
failed request. Ask the public identity route first and only call the gated
route when the visitor actually holds the role.

**Why:** the release QA walk treats any console error as a failure, and a page
that cries 401 on every anonymous visit buries real errors in noise. The
server-side gate is unaffected either way — this is purely about what the
browser reports.

**How to apply:** on page init, resolve identity from the public `me` route,
branch to the access notice when the role is missing, and keep the existing
401 branch as the fallback. Never treat the client-side check as the gate.

## Background browser jobs

Long shell jobs backgrounded with `nohup`/`setsid` are killed between tool
calls in this environment. Run test suites in the foreground, batched to fit
the command timeout, rather than polling a background runner.

## Favicon

Pages carry `<link rel="icon" href="data:,">`. Without it the browser requests
`/favicon.ico`, which 404s and shows up as a console error on every page.
