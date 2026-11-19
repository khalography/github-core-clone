# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/khalography/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/khalography/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process with no dependencies: git smart HTTP (upload-pack v2, receive-pack v0) for clone, fetch and push; the REST v3 API for repositories, issues, pull requests and contents; the GraphQL v4 API; and a Model Context Protocol endpoint. Everything it serves is its own, no outside service, no proxy and no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port of its own and registers it with the trial environment through `MAKEFUN_ENV_URL`. It needs no other configuration.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
