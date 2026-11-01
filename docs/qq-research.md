# QQ NT Windows research and implementation decision

Research date: 2026-11-01. No real QQ installation is available in this Linux environment; Windows acceptance remains required. QQ internal formats are version dependent.

## Existing WeChat path

`mcp/server.ts` registers contracts and dispatches through `tools.ts`, `query.ts` and `conversation.ts`. `McpRuntime` delegates to `LocalBackendClient` and Python `weflow_backend`; profile preparation supplies keys. `python/wxtext/windows.py` uses same-user/session process checks and read-only OpenProcess/ReadProcessMemory. `keyscan.py` authenticates WeChat key candidates; its WeChat-specific offsets/derivation cannot be used for QQ. `cipher.py`, `wal.py`, and the backend's live reader handle SQLCipher and committed WAL data. MCP revisions invalidate cursors. The stdio launcher runs built code; code changes require build and client reconnect, not live module replacement. Profile readiness is checked on calls.

## Primary sources

- [QQBackup Windows key research](https://github.com/QQBackup/qq-win-db-key/blob/master/教程%20-%20NTQQ%20(Windows).md): locate `nt_sqlite3_key_v2` in QQ's `wrapper.node`; pKey/nKey are the third/fourth arguments. Frida/debugger hooks depend on QQ version and capture keys when databases open. A captured 20-byte key can belong to another database. Hooks inject into QQ and are excluded from the read-only implementation.
- [QQBackup decryption parameters](https://github.com/QQBackup/qq-win-db-key/blob/master/基础教程%20-%20NTQQ%20解密数据库.md): 1024-byte QQ extension precedes SQLCipher, not SQLCipher's plaintext-header setting; page size 4096, kdf_iter 4000, AES-256-CBC, HMAC_SHA1 (some older versions SHA256), PBKDF2_HMAC_SHA512. The password is a byte string, often 32 printable bytes; a hex-looking string must not automatically become a raw SQLCipher key.
- [Current reference decryptor](https://github.com/QQBackup/nt_msg_db_util/blob/master/1.decrypt.py): sets page size before key, then KDF/HMAC pragmas, validates sqlite_master. Do not copy its corruption-skipping export policy: silently dropping rows would misrepresent coverage.
- [C2C columns](https://github.com/QQBackup/nt_msg_db_util/blob/master/db_docs/c2c_msg_table/summary.md), [group columns](https://github.com/QQBackup/nt_msg_db_util/blob/master/db_docs/group_msg_table/summary.md), [protobuf schema](https://github.com/QQBackup/nt_msg_db_util/blob/master/msgdb/proto/c2c_40800.proto).
- [QQ database documentation](https://github.com/QQBackup/QQDecrypt/tree/main/docs/database/db_file_analysis): recent_contact_v3_table, buddy_list and group_detail_info_ver1.

## Layout and semantics

Typical root: `%USERPROFILE%\Documents\Tencent Files\<uin>\nt_qq\nt_db`; Documents may be redirected and users may move data. Explicit configuration avoids silently picking a stale copy or another account. `nt_msg.db` contains `c2c_msg_table` / `group_msg_table`; related databases include `recent_contact.db`, `profile_info.db`, `group_info.db`. Keep `-wal` with its database; never assume the main file alone contains current messages.

Numeric identifiers must be quoted in SQL. 40001 = message ID (64-bit, return strings), 40050 = Unix seconds, 40030 = conversation peer QQ/group number, 40033 = sender QQ, 40020 = sender NT UID, 40021 = peer UID, 40027 = local conversation partition. 40013: 0 received, 1/2 self, 3 system; other values unknown. 40090 group sender card and 40093 sender nickname are **sender** names, not group names. Group 40003 is group sequence; C2C 40003 has different semantics. Group 40850 may reference a sequence; C2C 40850 may be a reaction target, so do not fabricate quote relationships.

40800 is protobuf `MsgBody` containing repeated field **40800**, each `MsgContent` contains type 45002 and text 45101. It is not UTF-8 JSON and not a generic field-1 wrapper. Mixed/media/unknown elements need explicit unresolved markers. Never scrape arbitrary printable bytes as message text. Recent-contact 40093/40090 are last-sender names, not reliable conversation names. Buddy list uses 1000 UID, 1002 UIN; names vary by version. Group detail/list uses 60001 group ID, 60007 name, 60026 remark. Fail closed on missing required message columns; use ID fallback for unavailable names.

## Decision

Use separate `qq_` mirror tools with existing envelope/argument schemas and opaque process-local cursors. QQ does not require a WeChat profile. Reuse the configured Python interpreter and existing sqlcipher3 dependency. Open only disposable copies: strip the extension from the copy, copy WAL, allow SQLite recovery only in the temporary directory, then enable query_only. Detect source changes during capture and retry/fail rather than claim consistency. Fresh calls recapture current files, so new committed messages need no restart. Configuration is reread each call; continuations bind to source/config revision and fail when stale. Code reload follows existing build/reconnect behavior.

A configured local key file is the reliable baseline: preserve exact password bytes via JSON `password`, including hex-looking passwords. No keys in tool arguments, command lines, stdout or diagnostics. No automatic process scanning during MCP reads. Optional explicit bounded memory candidate extraction can reuse the Windows read-only process reader; failure to find a candidate is not proof QQ is logged out. Unsupported QQ versions require a separately captured password; no injected hook, rekey, checkpoint, send, network or QQ automation is performed by this feature.

Limits must be visible: local history only; no cloud fetch, OCR, voice transcription, media download or complete roster claim. Windows live-WAL behavior and installed SQLCipher availability must be verified on the target machine. Metadata change detection is a conservative capture guard, not an OS-level atomic snapshot guarantee.
