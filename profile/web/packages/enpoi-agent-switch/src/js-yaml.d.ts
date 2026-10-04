/**
 * Minimal ambient types for the js-yaml members this plugin uses. The profile
 * has no `@types/js-yaml`; only `JSON_SCHEMA` (+ `extend`), `Type`, and `load`
 * are read here.
 */
declare module 'js-yaml' {
  /** A composed YAML schema; `extend` returns a new schema. */
  export class Schema {
    extend(...schemas: unknown[]): Schema
  }
  /** YAML 1.2 core schema (the permissive default for preset files). */
  export const JSON_SCHEMA: Schema
  /** Custom scalar/tag type, used here to tolerate `!!js` preset rows. */
  export class Type {
    constructor(tag: string, options: Record<string, unknown>)
  }
  /** Parse one YAML document. */
  export function load(source: string, options?: Record<string, unknown>): unknown
}
