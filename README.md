# usage-band

A slim band above the Claude Code prompt that shows three things at a glance:

- **7D**: how much of your 7-day usage window is left, and when it resets.
- **5H**: how much of your 5-hour window is left, and when it resets.
- **CACHE**: whether your prompt cache is **WARM**, **COOLING** (under 10 minutes left) or **COLD**, with the minutes left or the idle time, and how many tokens the cache holds.

Each dot bar shows what is left, not what is used. A window under 15% adds a bold **LOW**. The band redraws every 30 seconds so countdowns stay current, and it costs nothing to run: it reads the app's own usage figures and never calls a model.

The prompt cache lives for one hour after the last request. A `/clear` or compaction resets the cache reading until the next reply; a resumed session seeds it from how long the session was away.

Wide bands fit everything on one row. Narrower ones stack each window into a small block, and the narrowest give the cache its own row. The terminal gets the same facts as plain text.

Adapted from [ribbon](https://github.com/robonuggets/ribbon) by Jay E (MIT), without the drawings, embedded font and price table.

## Install

In a Claude Code terminal session, type:

```
/plugin install usage-band --marketplace joshkerr/usage-band
```

Type `y` when it asks to add the marketplace, pick the **user** scope, then start a new session.

From a shell:

```
claude plugin install usage-band --marketplace joshkerr/usage-band
```

## Remove

```
claude plugin uninstall usage-band
```

## Develop

Load the folder without installing it, and run the tests:

```
claude --plugin-dir ./usage-band
claude plugin test ./usage-band
```

## License

MIT. Adapted from [ribbon](https://github.com/robonuggets/ribbon) by Jay E, also MIT.
