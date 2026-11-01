# Windows WeChat media: research and MCP implementation

Researched 2026-11-01. Storage and encryption details below are reverse-engineered compatibility behavior, not a Tencent API guarantee. Synthetic tests run on Linux; actual Windows accounts and client builds still need validation.

## Existing repository components

- `mcp/media.ts`: existing `get_media(message_id, representation, quality)` resolves a message, extracts image MD5, asks the Python hardlink resolver, reads cached image keys, decrypts with shared helpers, converts HEIC with the isolated worker, and uses sharp for bounded inline images. Previously it handled only images, returned no usable local decoded path, required cached keys even for old XOR, and sent V1 through the XOR branch.
- `shared/chat/normalize.ts`, `decode.ts`, `ids.ts`: decode compressed/group message content and large local_type values, identify image/type-6 file messages, and produce account-scoped stable message IDs. File attachments previously exposed only title and unknown availability. These IDs remain unchanged.
- `shared/chat/imageDecrypt.ts`: single-byte XOR and AES-128-ECB/PKCS7 + plaintext + XOR decoding, including size and padding checks. Reused rather than reimplemented.
- `electron/services/imageDecryptService.ts`: account selection, hardlink batching, local image lookup, native decoding with JS fallback, cache resolution, preview/original selection, and HEIC conversion. GUI image key acquisition is separate from MCP's read-only cached-key access. `chatService.ts` parses file title/MD5 and knows legacy media roots; export services can export media through the application. MCP message exports primarily export conversation records, not a complete attachment archive.
- `python/weflow_backend/backend.py::resolveImageHardlink`: queries `hardlink.db`, `image_hardlink_info_v4` and `dir2id`; selects existing `msg/attach/<dir1>/<dir2>/Img/<file_name>` candidates, preferring `_h.dat`, then standard, then `_t.dat`. No local candidate returns a missing-download response. Live and snapshot use the backend's existing read lifecycle.
- `python/weflow_backend/image_keys.py`: local V2 probes, strict candidate/padding validation, read-only Windows process-memory scanning during explicit key preparation, account-scoped DPAPI cache. `getCachedImageKeys` only reads that cache; a normal MCP media read never initiates memory scanning or key acquisition. Database keys and image keys are distinct.
- `python/wxtext`: Windows process access, database key discovery, SQLCipher/WAL reads, state and snapshots. It is not an attachment downloader. The integrated backend targets WeChat 4.x; legacy media compatibility does not add a WeChat 3.x database reader.

## Disk layouts and references

Typical account roots are `Documents/WeChat Files/<account>` for 3.x and `Documents/xwechat_files/<account>` for 4.x, with configurable/redirected drives. Never derive the account from the directory's spelling; use the connected profile. `db_storage` is a database child, not the account root.

| Item | Common storage | Consequence |
| --- | --- | --- |
| 3.x image | `FileStorage/Image/<yyyy-mm>/*.dat`, also `Image2` and historical/indexed layouts | XOR container is not an ordinary JPEG with a changed extension; filenames alone may not map a message. |
| 3.x file | `FileStorage/File/<yyyy-mm>/<name>` | Ordinary file bytes; some layouts have a flat File directory. |
| 4.x image | `msg/attach/<md5(chat username)>/<yyyy-mm>/Img/*.dat` | Group hash uses the conversation username including `@chatroom`, not the individual sender. Prefer the hardlink database to filename guessing. |
| 4.x file | `msg/file/<yyyy-mm>/<name>` | Files can be renamed for collisions, or downloaded into a later month. |

The 4.x paths and local resource associations are documented in the primary [wechatauto media implementation](https://raw.githubusercontent.com/fanyuantaier/wechatauto-replica/main/wechatauto/media.py). Its `message_resource.db`/packed_info support shows why a filename is not always derivable from XML alone. This implementation does not yet parse that resource database.

`_t.dat` denotes a thumbnail; `_h.dat` denotes high-definition; an unsuffixed file is the standard rendition. These labels identify the stored variant, not proof of the sender's original bytes. The [wx-cli implementation documentation](https://github.com/kylexlau/wx-cli) independently describes account-local attachments and the three DAT families.

Type 49 / appmsg type 6 describes a file. The XML typically has title, appattach/totallen, fileext, and MD5; it may also contain CDN references and transfer keys. XML metadata is not file content or proof of download. The primary [OpenWechat message implementation](https://raw.githubusercontent.com/eatmoreapple/openwechat/master/message.go) defines the appmsg/attachment distinction and XML metadata. WeFlow reads these references as data and never calls its download/send APIs.

A group attachment is associated with its message and chat just like a private attachment. A file sent as a file remains kind=file even if its extension is JPG or MP4. Deleted, expired, never-downloaded, mobile-only and reference-only attachments remain visible in message/list results but cannot be opened locally.

## Image formats and keys

| Format | First six bytes | Decode |
| --- | --- | --- |
| Legacy / V0, common in 3.x | No version marker | Every byte XORed with one byte. Infer candidates from several image-header bytes, then validate with an image decoder. |
| V1 transitional | `07 08 56 31 08 07` | AES-128-ECB prefix with fixed ASCII key `cfcd208495d565ef`, plaintext middle, XOR tail. |
| V2, common in 4.x | `07 08 56 32 08 07` | Same segmented structure with account-specific image AES/XOR keys. |

V1/V2 use a 15-byte header: signature, little-endian plaintext AES length at offset 6, XOR length at offset 10, and one reserved byte. AES ciphertext occupies `aes_length + (16 - aes_length % 16)` bytes, including a full PKCS7 block when aligned. The remaining payload is a plaintext middle and the specified XOR suffix. Reject malformed lengths and padding. V1 fixed-key behavior is described by [wx-cli](https://github.com/kylexlau/wx-cli); terminology for other legacy headers varies between projects, so unknown headers are not assumed to be this V1.

For supported 4.x builds, the account config dword can derive `xor = dword & 255` and `aes = MD5(decimal(dword) + wxid).hexdigest()[:16]` as ASCII bytes, not hex-decoded bytes. Windows implementations also scan process memory for ASCII AES candidates and validate against encrypted local samples. Thumbnail JPEG tails can help infer XOR; this is a heuristic and container footers can invalidate it. See the primary [derivation and validation code](https://raw.githubusercontent.com/fanyuantaier/wechatauto-replica/main/wechatauto/media.py). These observations are build-dependent; MCP continues using the repository's already-validated cached V2 keys and does not introduce a speculative derivation path.

Legacy XOR no longer needs a prepared key cache. V1 infers an XOR candidate from supported JPEG/PNG/GIF tail markers and checks decoded image metadata; unrecognized tails fail explicitly. V2 without cached keys returns `key_required`. HEIC uses the existing JPEG conversion worker. WXGF/WXAM images are converted to a first-frame JPEG using the Electron decoder’s Annex-B VPS grouping heuristic and ffmpeg-static (or ffmpeg on PATH). This is a still preview: animation and a separate alpha/mask stream are not preserved. Unsupported or malformed containers return `decode_failed`.

## MCP contract and lifecycle

Existing tool names and input schemas remain intact, including `get_media`'s metadata/image/text representations and its inline budgets. Additive attachment fields appear on normalized messages, compact details and search hits:

- `id`: `att:` plus the existing stable, account-scoped message ID. No process-local registry is needed, so IDs survive MCP restart while the underlying message locator remains valid.
- `kind`, optional `name`/`title`, `size` in bytes, `file_type`, `md5`, and `availability`.
- Read/search/list resolve current disk availability (`available` or `not_downloaded`) and `downloaded`; image `variant` is `thumbnail`, `standard`, `original` or `unknown`. Availability confirms local bytes, not successful decryption. Some normalized-only outputs, such as exports or context, retain `unknown` until fetched.

`list_attachments` accepts `chat_id`, `kind=image|file|all`, optional `range`, `direction`, `limit` (1–500) and `max_chars`. It returns `data.messages` with chat/sender tables and the standard coverage envelope. Date ranges follow the existing half-open semantics. Without a range it uses the standard 24-hour recent-message range; pass an explicit range to list history. Continue with only `cursor` on the same tool. Replay and revision invalidation use the existing cursor store; scan tool names are checked even for cached pages to prevent cross-tool replay.

`get_attachment` accepts `attachment_id`, optional `inline_image` and `quality=preview|original`. It re-resolves the message and filesystem every call. Files return their verified absolute `local_path`; images return a decoded file under `<userData>/media-cache/<accountScope>/<sha256>.<extension>`. Cache content hashes avoid stale replacements; writes use unique temporary names and rename. HEIC is converted to JPEG and marked transformed. Inline preview remains bounded at 1600 pixels / 4 MiB, original inline at 10 MiB; image input has a 64 MiB processing limit. The local path can succeed even when inline content exceeds its budget (`inline_availability`). Quality controls inline resizing; the cache retains the decoded stored rendition and reports its variant. No tool executes or automatically opens a file; the caller may read it or use a local viewer.

File fallback searches account-local v4/v3 file month directories, starting with the message month, then other month directories, plus the legacy flat directory. Size (when known) and full MD5 must match, so renamed copies work and unrelated same-title files are rejected. Missing MD5 is deliberately unresolved. File hashing can be expensive on large archives and is cancellable. Image fallback checks the known chat-hash/month and legacy Image/Image2 month locations using the image MD5. Nonstandard legacy names, resource-only identifiers and unindexed layouts remain unresolved.

Filesystem candidates are realpath-confined to the account root, including junction/symlink targets. XML paths are never accepted. WeChat sources are opened for reads only; all image writes go to app data. New fetch operations are blocked on the existing remote HTTP transport; use the local stdio entrypoint. This change starts no HTTP endpoint or tunnel and adds no send/download action. Existing Windows `D:\dora_workspace\weflow\call.cjs` can keep calling existing tool names/contracts; no change to that external wrapper was made here.

Live database reads, revision checks, invalidation callbacks and reconnect behavior are reused. Stable attachment IDs do not pin disk paths. Cursor pages replay their original availability, but a fresh fetch observes files downloaded/changed since listing. Content-addressed image cache entries are not indexed as authoritative lookup results. Cache files are sensitive plaintext and persist until removed from app data; automatic eviction is not implemented.

## Validation and Windows checklist

Synthetic tests cover XOR/V1/V2 PNG/JPEG data, aligned AES prefix plus plaintext middle and XOR suffix, malformed lengths, missing V2 keys, file XML/CDATA, group identity, renamed files, MD5 mismatch, missing downloads, symlink escape, source-byte preservation, cache paths, inline output, search metadata, date/kind filtering, pagination replay and revision invalidation. Existing HEIC isolation and inline-budget tests remain in place.

Validation in this Linux workspace: `npm run build:mcp` passed; `npm run test:mcp` passed 91 tests with one Windows/client integration test skipped; `npm run typecheck` passed; `npm run test:agent` passed 3 tests; `npm run test:qq` passed 13 tests. The full, unchanged Python backend suite ran 57 tests with 1 failure, 10 errors and 6 skips: Windows DPAPI requirements, Windows path expectations and unavailable `MMFtsTokenizer` prevent a passing full backend run here. No Python backend code was changed. Run that suite on the supported Windows runtime before release.

On Windows verify:

1. The existing stdio wrapper still calls `get_status`, `find_chats`, `read_messages`, `search_messages` and `get_media` unchanged; call both new tools by name.
2. Use an explicit historical range on a real group. Match file title/size and stored variants against WeChat. Verify missing/reference-only files are listed and do not trigger downloads.
3. Open returned PDF/Office paths and decoded images using local applications. Check duplicate names and files downloaded in a later month. Verify source timestamps/bytes remain unchanged.
4. Test real V0/V1/V2 samples, `_t`, unsuffixed and `_h` renditions, absent/expired image-key cache, HEIC, redirected data directories and packaged HEIC worker paths. Do not claim support for undocumented containers based on synthetic success.
5. Keep WeChat running, receive a new image/file, download an existing attachment manually, then reread/fetch without restarting MCP. Confirm freshness invalidation and that existing attachment IDs still resolve after MCP restart/account reconnect; cross-account IDs must fail.
6. Inspect app-data cache location and confirm no decoded media appears in the checkout. Check Windows junction confinement and local file permissions. No share/tunnel command is needed.

WXGF has a variable main header (magic, header length, version and dimensions), optional version-dependent extra headers, and data partitions. Annex-B HEVC start codes allow extracting candidate streams without fully parsing the private headers; animated variants may interleave color and mask partitions. The largest VPS group is a heuristic, not a complete WXAM parser. See [WXAM format analysis](https://sarv.blog/posts/wxam/).
