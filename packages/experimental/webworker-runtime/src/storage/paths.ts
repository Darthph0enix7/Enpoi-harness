/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const DSH_ROOT = '/dsh'

/** `$DSH_HOME`: durable-state directory inside the image. */
export const DSH_HOME = `${DSH_ROOT}/home`

/** Temporary directory reported by `os.tmpdir()`. */
export const DSH_TMP = `${DSH_ROOT}/tmp`
