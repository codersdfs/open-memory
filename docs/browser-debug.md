# Debugging the console in a browser

An agent drives the console through the `pi-computer-use` tools (`launch_browser` →
`navigate_browser` → `evaluate_browser`). Three properties of that path cost time to
learn, so they are written down here rather than rediscovered.

1. **`evaluate_browser` gives up after 5 s.** Any wait inside the evaluated expression has
   to fit in ~3.5 s together with the DOM read. Split the call instead of waiting longer.
2. **A `stateId` goes stale as soon as the page renders again** (the CDP epoch moves), and
   the failure reads `State is stale for cdp:… expected epoch N, current epoch M`. Only
   `launch_browser` and `navigate_browser` are guaranteed to return a usable id, so one
   pass per route is `launch → navigate → evaluate`, and an id taken from a response is
   good for at most the following call.
3. **React ignores a synthetic value that arrives in the same tick as the click.** Setting
   `input.value` and dispatching `input` does update state, but the click handler's closure
   still holds the previous render — so the click submits the *old* value, and an empty one
   fires no request at all. Wait for one render (~300 ms) between the two, and dispatch
   `new MouseEvent("click", { bubbles: true, cancelable: true, view: window })`.
   A same-tick pair looks exactly like "the search button is broken" and is not a bug.

Collect errors once per page, then read `document.body.innerText` route by route:

```js
window.__dbg = { err: [], bad: [] };
addEventListener("error", (e) => __dbg.err.push(String(e.message || e)));
addEventListener("unhandledrejection", (e) => __dbg.err.push("rej: " + e.reason));
const of = fetch;
fetch = async (...a) => {
  const r = await of(...a);
  if (!r.ok) __dbg.bad.push(String(a[0]) + " " + r.status);
  return r;
};
```

The routes are `#/recall`, `#/memories`, `#/sessions`, `#/graph`, `#/stats`; `/graph.html`
is a separate page outside the console shell.

A first search with no preset touched is the check that the recall path is alive end to
end: type a query, click `search` (or `Cmd`/`Ctrl`+`Enter`), and expect both a
`POST /memories/search` at the default floor and a hit count in the panel.
