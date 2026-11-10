---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-session-projection-cache` requires two new config fields, `startupMaxAgeDays` and `maxResidentRecords`."
---

# Projection cache startup window and memory bound

English | [中文](guide.zh.md)

## Change

Previously the projection cache read every stored record under `storages/session_projcache/sessions/` into memory at startup, and its config held only `writeEveryEvents` and `writeIntervalMs`.

Now startup reads only the newest records changed in the last `startupMaxAgeDays` days, at most `maxResidentRecords` of them, and memory keeps at most `maxResidentRecords` complete records afterwards. Both fields are required. The shipped `base` bundle sets them to `30` and `300`, so the shipped profiles need no change. A custom `cordis.yml` or patch that writes the whole `config` block of the `session-projection-cache` entry without the two fields fails config validation at load. Stored records and Session logs keep their format.

## Migration

1. Search your own `cordis.yml` files and patches for the entry `id: session-projection-cache` or the name `@deepseek-ai/dsh-session-projection-cache`.
2. In each `config` block found, add the two fields next to the existing ones:

   ```yaml
   config:
     writeEveryEvents: 200
     writeIntervalMs: 5000
     startupMaxAgeDays: 30
     maxResidentRecords: 300
   ```

3. Code that mounts the plugin directly, for example `ctx.plugin(SessionProjectionCache, config)` in tests or embedded hosts, passes the same two fields.
4. Start the host. The migration worked when it loads without a config error for `session-projection-cache`; see the [package README](../../../../packages/session/session-projection-cache/README.md) for the field meanings.
