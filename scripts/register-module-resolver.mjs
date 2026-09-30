// Bootstrap that registers module-resolver.mjs as an ESM loader hook.
//
// Node >= 20 deprecated `--loader`, and on recent Windows builds (observed on
// v24) passing a plain path to `--loader` / `--import` crashes with
// ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'd:'") because the path
// is parsed as a URL. bridge.rs therefore passes THIS file as a file:// URL
// via `--import`, and this script registers the actual hook by relative path.
import { register } from "node:module";

register("./module-resolver.mjs", import.meta.url);
