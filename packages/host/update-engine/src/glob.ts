/**
 * Dependency-free glob matching for pins (§3.5) and scan ignores.
 *
 * Patterns are relative paths using '/' separators. `*` matches within one
 * path segment, `**` crosses segments (`**\/` also matches zero segments),
 * `?` matches one non-separator character, and `[abc]` character classes are
 * passed through. A pattern without wildcards matches by exact string
 * equality only.
 */

const compiled = new Map<string, RegExp>()

/**
 * Match one relative path against one glob pattern (or an exact path).
 * @param pattern - Glob pattern or exact relative path.
 * @param path - Relative path using '/' separators.
 * @returns True when the path matches.
 */
export function matchGlob(pattern: string, path: string): boolean {
  if (pattern === path) return true
  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) return false
  let regexp = compiled.get(pattern)
  if (regexp === undefined) {
    regexp = new RegExp(globToRegExp(pattern))
    compiled.set(pattern, regexp)
  }
  return regexp.test(path)
}

/**
 * Match one relative path against any pattern in a list.
 * @param patterns - Glob patterns or exact relative paths.
 * @param path - Relative path using '/' separators.
 * @returns True when at least one pattern matches.
 */
export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  for (const pattern of patterns) {
    if (matchGlob(pattern, path)) return true
  }
  return false
}

function globToRegExp(pattern: string): string {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1)
      if (close === -1) {
        source += '\\['
      } else {
        source += pattern.slice(index, close + 1)
        index = close
      }
    } else {
      source += escapeRegExp(char ?? '')
    }
  }
  return source + '$'
}

function escapeRegExp(input: string): string {
  return input.replace(/[.+^${}()|\\]/gu, '\\$&')
}
