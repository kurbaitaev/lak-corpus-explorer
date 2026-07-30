---
name: Local test server ports
description: Node's built-in fetch silently refuses some ports; pick test ports outside the blocked list.
---

Test suites here spawn their own server and poll it with Node's built-in `fetch`. That client
enforces the WHATWG **bad-ports list**, so a request to a server on e.g. 5060 or 5061 always
throws — which looks exactly like "the server never came up" when the poll swallows the error.

**Why:** a suite once burned its whole timeout waiting for an import that had in fact finished
seconds after boot; the server was fine, the port was unreachable to `fetch`.

**How to apply:** choose test ports outside the bad-ports list (5055–5058 and 5062 are in use
here and work), and never swallow the fetch error in a readiness loop — log it, or the next
person debugs the wrong component.
